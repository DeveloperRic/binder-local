var mongoose = require("mongoose");

var historyItemSchema = mongoose.Schema({
  fileId: { type: "ObjectId" },
  date: { type: Number, required: true },
  ipAddress: { type: String, trim: true },
  reason: { type: String, trim: true }
});

var blockSchema = mongoose.Schema({
  owner: {
    type: "ObjectId",
    index: true,
    required: true
  },
  bucket: {
    type: "ObjectId",
    required: true
  },
  provisioned: {
    type: Boolean,
    default: false
  },
  maxSize: {
    type: Number,
    min: 0,
    set: v => Math.ceil(v),
    required: true
  },
  latestSize: {
    type: Number,
    min: 0,
    default: 0
  },
  fileCount: {
    type: Number,
    min: 0,
    default: 0
  },
  binned: {
    type: Boolean,
    default: false
  },
  mergedInto: {
    type: {
      block: { type: "ObjectId", required: true },
      bucket: { type: "ObjectId", required: true }
    }
  },
  mergedWith: {
    type: [
      {
        id: { type: "ObjectId", required: true },
        oldBucket: { type: "ObjectId", required: true }
      }
    ],
    default: []
  },
  log: {
    provisionedDate: {
      type: Number
    },
    fileAddHistory: {
      type: [historyItemSchema],
      default: []
    },
    fileBinnedHistory: {
      type: [historyItemSchema],
      default: []
    },
    fileRestoredHistory: {
      type: [historyItemSchema],
      default: []
    },
    blockBinnedHistory: {
      type: [historyItemSchema],
      default: []
    },
    blockRestoredHistory: {
      type: [historyItemSchema],
      default: []
    },
    blockMergedHistory: {
      type: [historyItemSchema],
      default: []
    },
    lastestSizeCalculationDate: {
      type: Number
    },
    sizeHistory: {
      type: [
        {
          date: { type: Number, required: true },
          size: { type: Number, required: true }
        }
      ],
      default: () => [{ date: Date.now(), size: 0 }]
    }
  }
});

var Block = (module.exports = mongoose.model("Block", blockSchema));
