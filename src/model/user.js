var mongoose = require("mongoose");
var bcrypt = require("bcryptjs");

//TODO copy models into other applications
// *only copy the models used in the specific application

var planSchema = mongoose.Schema({
  stripe_subscription_id: {
    type: String,
    required: true
  },
  tier: {
    type: String,
    enum: ["BASIC", "MID", "TOP"],
    required: true
  },
  currentPeriodStart: {
    type: Number,
    required: true
  },
  lengthInMonths: {
    type: Number,
    min: 1,
    required: true
  },
  expired: {
    type: Boolean,
    default: false
  },
  blocks: {
    type: ["ObjectId"],
    required: true,
    validate: v => v.length > 0
  },
  defaultBlockSize: {
    type: Number,
    min: 0,
    set: v => Math.ceil(v),
    required: true
  },
  maxTotalSize: {
    type: Number,
    min: 0,
    set: v => Math.ceil(v),
    required: true,
    validate: v => v >= this.plan.defaultBlockSize
  },
  latestTotalSize: {
    type: Number,
    min: 0,
    default: 0
  },
  log: {
    type: {
      purchasedDate: {
        type: Number
      }
    },
    // get rid of this once a log item has
    // an assigned default value
    default: {}
  },
  renewals: {
    type: [
      {
        renewalDate: {
          type: Number,
          required: true
        },
        renewalReason: {
          type: String,
          trim: true,
          required: true
        },
        oldTier: {
          type: String,
          enum: ["BASIC", "MID", "TOP"],
          required: () => this.newTier != null
        },
        newTier: {
          type: String,
          enum: ["BASIC", "MID", "TOP"],
          required: () => this.oldTier != null
        },
        oldMaxTotalSize: {
          type: Number,
          min: 0,
          set: v => Math.ceil(v),
          required: () => this.newMaxTotalSize != null
        },
        newMaxTotalSize: {
          type: Number,
          min: 0,
          set: v => Math.ceil(v),
          required: () => this.oldMaxTotalSize != null
        }
      }
    ],
    default: []
  }
});

var userSchema = mongoose.Schema({
  email: {
    type: String,
    index: true,
    unique: true,
    required: true,
    trim: true,
    validate: v =>
      /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/.test(
        v.toString().toLowerCase()
      )
  },
  email_verified: {
    type: Boolean,
    default: false
  },
  plan: {
    type: planSchema
  },
  profile: {
    type: Object,
    required: true
  },
  stripe_customer_id: {
    type: String
  },
  createdDate: {
    type: Number,
    default: () => Date.now()
  }
});

var User = (module.exports = mongoose.model("User", userSchema));

module.exports.createUser = function(newUser, callback) {
  savePasswordHash(newUser, callback);
};

module.exports.changePassword = function(uid, password, callback) {
  this.findById(uid, (err, user) => {
    if (err) return callback(err, null);
    user.password = password;
    savePasswordHash(user, callback);
  });
};

function savePasswordHash(user, callback) {
  bcrypt.genSalt(10, function(err, salt) {
    if (err) return callback(err);
    bcrypt.hash(user.password, salt, function(err, hash) {
      if (err) return callback(err);
      user.password = hash;
      user.save(callback);
    });
  });
}

module.exports.comparePassword = function(givenPassword, hash, callback) {
  bcrypt.compare(givenPassword, hash, function(err, isMatch) {
    if (err) return callback(err);
    callback(null, isMatch);
  });
};
