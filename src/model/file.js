var mongoose = require("mongoose");

var historyItemSchema = mongoose.Schema({
  date: { type: Number, required: true },
  ipAddress: { type: String, trim: true },
  reason: { type: String, trim: true }
});

var fileSchema = mongoose.Schema({
  idInDatabase: {
    type: String,
    required: true,
    index: true,
    unique: true
  },
  nameInDatabase: {
    type: String,
    required: true
  },
  localPath: {
    type: String,
    required: true,
    index: true,
    immutable: true
  },
  owner: {
    type: "ObjectId",
    required: true,
    index: true,
    immutable: true
  },
  plan: {
    type: "ObjectId",
    required: true
  },
  block: {
    type: "ObjectId",
    required: true
  },
  bucket: {
    type: "ObjectId",
    required: true
  },
  upload: {
    started: { type: Number },
    paused: {
      type: Number,
      validate: v => !this.upload.finished && v > this.upload.started
    },
    finished: {
      type: Number,
      validate: v => !this.upload.paused && v > this.upload.started
    }
  },
  download: {
    started: { type: Number, required: true },
    paused: {
      type: Number,
      validate: v => !this.download.finished && v > this.download.started
    },
    finished: {
      type: Number,
      validate: v => !this.download.paused && v > this.download.started
    }
  },
  ignored: {
    type: Boolean,
    default: false
  },
  binned: {
    type: Boolean,
    default: false
  },
  pendingDeletion: {
    type: Boolean,
    default: false
  },
  deleted: {
    type: Boolean,
    default: false
  },
  originalSize: {
    type: Number,
    min: 0,
    required: true,
    immutable: true
  },
  latestSize: {
    type: Number,
    min: 0,
    default: () => this.originalSize
  },
  versions: {
    list: {
      type: [
        {
          idInDatabase: {
            type: String,
            required: true,
            immutable: true
          },
          dateInserted: {
            type: Number,
            required: true,
            immutable: true
          },
          dateDeleted: {
            type: Number,
            immutable: true
          },
          originalSize: {
            type: Number,
            required: true,
            immutable: true
          },
          initVect: {
            type: String,
            required: true,
            immutable: true
          }
        }
      ],
      default: []
    },
    count: {
      type: Number,
      min: 0,
      default: 0,
      set: v => Math.floor(v)
    },
    activeCount: {
      type: Number,
      min: 0,
      validate: v => v <= this.versions.count,
      default: 0,
      set: v => Math.floor(v)
    }
  },
  log: {
    detected: {
      type: Number, // date detected
      index: true
    },
    updateHistory: {
      list: {
        type: [historyItemSchema],
        default: []
      },
      count: {
        type: Number,
        min: 0,
        default: 0,
        set: v => Math.floor(v)
      }
    },
    binnedHistory: {
      list: {
        type: [historyItemSchema],
        default: []
      },
      count: {
        type: Number,
        min: 0,
        default: 0,
        set: v => Math.floor(v)
      }
    },
    restoredHistory: {
      list: {
        type: [historyItemSchema],
        default: []
      },
      count: {
        type: Number,
        min: 0,
        default: 0,
        set: v => Math.floor(v)
      }
    },
    rollbackHistory: {
      list: {
        type: [historyItemSchema],
        default: []
      },
      count: {
        type: Number,
        min: 0,
        default: 0,
        set: v => Math.floor(v)
      }
    },
    lastestSizeCalculationDate: {
      type: Number
    },
    sizeHistory: {
      list: {
        type: [
          {
            date: { type: Number, required: true },
            size: { type: Number, required: true }
          }
        ],
        default: []
      },
      count: {
        type: Number,
        min: 0,
        default: 0,
        set: v => Math.floor(v)
      }
    },
    dateDeleted: {
      type: Number
    },
    lastModifiedTime: {
      type: Number
    }
  }
});

var File = (module.exports = mongoose.model("File", fileSchema));
