var mongoose = require("mongoose");

var downloadSchema = mongoose.Schema({
  user: {
    type: "ObjectId",
    required: true,
    index: true
  },
  files: {
    list: {
      type: [
        {
          id: {
            type: "ObjectId",
            required: true
          },
          b2_bucket_id: {
            type: String,
            required: true
          },
          idInDatabase: {
            type: String,
            required: true
          },
          nameInDatabase: {
            type: String,
            required: true
          },
          localPath: {
            type: String,
            required: true
          },
          size: {
            type: Number,
            min: 0,
            required: true
          },
          capturedDate: {
            type: Number
          },
          decryptedDate: {
            type: Number
          }
        }
      ],
      required: true,
      validate: v => v.length > 0
    },
    count: {
      type: Number,
      min: 1,
      required: true
    },
    totalSize: {
      type: Number,
      min: 0,
      required: true
    },
    commonPrefix: {
      type: String,
      required: true
    }
  },
  active: {
    type: Boolean,
    default: true
  },
  complete: {
    type: Boolean,
    default: false
  },
  finishBy: {
    type: Number,
    min: 0,
    required: true
  },
  //TODO expires on should have a default and validator
  expiresOn: {
    type: Number,
    required: true,
    // default: () => this.finishBy + 24*60*60*1000,
    // validate: v => v >= this.finishBy,
    expires: 0
  },
  releasePath: {
    type: String,
    trim: true,
    required: true
  },
  log: {
    requestedDate: {
      type: Number,
      required: true
    },
    requestedFromIp: {
      type: String,
      trim: true
    },
    completedDate: {
      type: Number
    }
  }
});

downloadSchema.index({ expiresOn: 1 }, { expireAfterSeconds: 0 });

var Download = (module.exports = mongoose.model("Download", downloadSchema));
