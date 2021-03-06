const mongoose = require('mongoose');
const url = require('url');
const moment = require('moment');
const { Post, Member, Comment, Setting } = require('./src/model');
const FB = require('fb');

require('dotenv').config();
const fb = new FB.Facebook();
fb.options({ Promise: Promise });

console.log('CRON: Start');

let nextDayUpdateUserPost = moment()
  .startOf('day')
  .add(1, 'day');

//setting
const setting_newsfeed_limit = parseInt(process.env.NEWSFEED_LIMIT, 10) || 100;
const setting_newsfeed_max = parseInt(process.env.NEWSFEED_MAX, 10) || 300;
let setting_newsfeed_since;

async function recountUserPost() {
  console.log('CRON: recountUserPost.');
  try {
    const aggregatorOpts = [
      {
        $match: {
          is_deleted: { $ne: true }
        }
      },
      {
        $unwind: '$from'
      },
      {
        $group: {
          _id: '$from.id',
          count: { $sum: 1 }
        }
      },
      {
        $sort: {
          count: -1
        }
      }
    ];

    const memberList = await Post.aggregate(aggregatorOpts).exec();
    await Member.update({}, { $unset: { post_count: 1 } }, { multi: true });

    await Promise.all(
      memberList.map(async (item, index) => {
        const resp = await Post.findOne(
          {
            'from.id': item._id
          },
          'from.name',
          {
            sort: {
              created_time: -1
            }
          }
        );

        if (resp) {
          let member = new Member({
            _id: item._id,
            name: resp.from.name,
            post_count: item.count
          });
          await Member.findByIdAndUpdate(item._id, member, { upsert: true });
        }
      })
    );
  } catch (error) {
    console.log(`CRON: ERROR recountUserPost: ${error}`);
  }
}

async function getNewsFeed(group_id, since, limit, max) {
  let data = [];

  let run = true;

  limit = limit || setting_newsfeed_limit;
  since = since || setting_newsfeed_since;
  max = max || setting_newsfeed_max;

  let until = undefined;
  let icon_size = undefined;
  let __paging_token = undefined;

  while (run) {
    const fbResponse = await fb.api(`${group_id}/feed`, {
      fields: ['id', 'from', 'message', 'object_id', 'created_time', 'updated_time', 'likes'],
      access_token: process.env.FACEBOOK_ACCESS_TOKEN,
      limit,
      since,
      until,
      icon_size,
      __paging_token
    });

    // check no response data
    if (run && (!fbResponse || !fbResponse.data || fbResponse.data.length === 0)) {
      run = false;
      console.log(`CRON: stop loop when no response data`);
    } else {
      // concat response data
      data = data.concat(fbResponse.data);
    }

    // check over max feed
    if (run && data.length > max) {
      run = false;
      console.log(`CRON: stop loop when over max`);
    }

    // check no paging
    if (run && (!fbResponse.paging || !fbResponse.paging.next)) {
      run = false;
      console.log(`CRON: stop loop when no paging`);
    }

    if (run) {
      const urlstring = fbResponse.paging.next;
      const queryData = url.parse(urlstring, true).query;
      icon_size = queryData.icon_size;
      limit = queryData.limit;
      until = queryData.until;
      since = queryData.since;
      __paging_token = queryData.__paging_token;
    }
  }

  return data;
}

async function getComment(post_id, since, limit) {
  let data = [];

  let run = true;
  let after = undefined;
  limit = limit || 500;

  if (since) {
    since = moment(since).unix();
  }

  while (run) {
    let commentResponse;
    try {
      commentResponse = await FB.api(`${post_id}/comments`, {
        fields: ['id', 'parent.fields(id)', 'message', 'from', 'created_time'],
        access_token: process.env.FACEBOOK_ACCESS_TOKEN,
        order: 'reverse_chronological',
        filter: 'stream',
        after,
        since,
        limit
      });
    } catch (error) {
      console.log(error);
    }

    // check no response data
    if (run && (!commentResponse || !commentResponse.data || commentResponse.data.length === 0)) {
      run = false;
    } else {
      data = data.concat(commentResponse.data);
    }

    // check no paging
    if (run && (!commentResponse.paging || !commentResponse.paging.cursors)) {
      run = false;
    }

    if (run) {
      after = commentResponse.paging.cursors.after;
    }
  }

  return data;
}

async function startJob() {
  console.log('CRON: startJob.');
  try {
    // check last 20 post if delete
    const last20posts = await Post.find({})
      .sort('-updated_time')
      .limit(20);
    for (const item of last20posts) {
      try {
        const fbPost = await fb.api(item._id, {
          fields: ['id'],
          access_token: process.env.FACEBOOK_ACCESS_TOKEN
        });
      } catch (error) {
        if (error.name === 'FacebookApiException') {
          const errorObj = JSON.parse(error.message);
          if (errorObj.error.code === 100 && errorObj.error.error_subcode === 33) {
            await Post.update({ _id: item._id }, { is_deleted: true });
          }
        }
      }
    }

    const setting_newsfeed_since_new = new Date();
    let lastUpdate = await Setting.findById('last_updated');
    if (lastUpdate) {
      lastUpdate = moment(lastUpdate.value);
    } else {
      lastUpdate = moment().add(-6, 'hours');
    }
    const mLastUpdate = lastUpdate.add(-30, 'minutes');
    console.log(`mLastUpdate = ${mLastUpdate}`);
    setting_newsfeed_since = mLastUpdate.unix();

    const newsFeedData = await getNewsFeed(process.env.FACEBOOK_GROUP_ID);
    console.log(`CRON: Get total ${newsFeedData.length} posts`);

    for (const item of newsFeedData) {
      let post = await Post.findById(item.id);

      if (!post) {
        post = new Post({
          _id: item.id,
          from: item.from,
          message: item.message,
          object_id: item.object_id,
          created_time: item.created_time,
          updated_time: item.updated_time,
          likes_count: item.likes.count
        });

        try {
          // save post
          await post.save();

          // find user and inc post count
          const member = {
            $set: {
              _id: item.from.id,
              name: item.from.name
            },
            $inc: { post_count: 1 }
          };
          await Member.findByIdAndUpdate(item.from.id, member, { upsert: true });
          console.log(`CRON: New post ${item.id}`);
        } catch (error) {
          console.log(`CRON: ERROR New post ${item.id} >> ${error}`);
        }
      }

      // get comment of post
      const comments_time = new Date();
      const comments = await getComment(post._id, post.comments_time);
      await Promise.all(
        comments.map(async (comment) => {
          if (!comment.message || comment.message === '') {
            return;
          }

          const newComment = new Comment({
            _id: comment.id,
            parent: comment.parent,
            post_id: post._id,
            message: comment.message,
            from: comment.from,
            created_time: comment.created_time
          });
          await Comment.findByIdAndUpdate(comment.id, newComment, { upsert: true });
        })
      );

      const comments_count = await Comment.count({ post_id: post._id });

      const updateObj = {
        likes_count: item.likes.count,
        comments_count,
        comments_time,
        updated_time: item.updated_time
      };

      // check post is edit
      if (item.message !== post.message) {
        updateObj.message = item.message; // save new
        updateObj.$push = { edit_history: post.message };
        console.log(`CRON: Edit post ${item.id}`);
      }

      // check new object id
      if (item.object_id !== post.object_id) {
        updateObj.object_id = item.object_id;
      }

      // save last time update comment
      await Post.update({ _id: post.id }, updateObj);
    }

    // save last crawl data
    await Setting.findByIdAndUpdate('last_updated', { value: setting_newsfeed_since_new }, { upsert: true });
  } catch (error) {
    console.log(`CRON: ERROR ${error}`);
  }

  try {
    const today = moment().startOf('day');

    if (nextDayUpdateUserPost === today) {
      await recountUserPost();
      nextDayUpdateUserPost = nextDayUpdateUserPost.add(1, 'day');
    }
  } catch (error) {
    console.log(`CRON: ERROR check recountUserPost: ${error}`);
  }
}

mongoose.Promise = global.Promise;
mongoose.connect(process.env.DATABASE_URI, {
  useMongoClient: true
}, async function(err, res) {
  if (err) {
    console.log('CRON: ERROR connecting to database: ' + err);
  } else {
    console.log('CRON: Succeeded connected to database.');
    await startJob();
    console.log('CRON: Finish');
    mongoose.connection.close();
    process.exit();
  }
});
