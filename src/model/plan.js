const mongoose = require("mongoose");

const historyItemSchema = mongoose.Schema({
  date: { type: Number, min: 0, required: true },
  ipAddress: { type: String, trim: true },
  reason: { type: String, trim: true }
});

const planSchema = mongoose.Schema({
  owner: {
    type: "ObjectId",
    required: true,
    index: true
  },
  stripe_subscription_id: {
    type: String,
    required: true,
    unique: true,
    sparse: true
  },
  tier: {
    type: "ObjectId",
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
  active: {
    type: Boolean,
    default: false
  },
  archived: {
    type: Boolean,
    default: false
    // validate: () => !!this.active
  },
  blocks: {
    type: ["ObjectId"]
    // validate: v => v.length > 0
  },
  defaultBlockSize: {
    type: Number,
    min: 0,
    set: v => Math.ceil(v),
    required: true,
    validate: v => v >= 1073741824
  },
  maxTotalSize: {
    type: Number,
    min: 0,
    set: v => Math.ceil(v),
    required: true,
    // validate: v => v >= this.defaultBlockSize
    validate: v => v >= 1073741824
  },
  latestTotalSize: {
    type: Number,
    min: 0,
    default: 0
  },
  periods: {
    list: {
      type: [
        {
          periodStart: {
            type: Number,
            required: true,
            unique: true,
            min: 0
          },
          periodEnd: {
            type: Number,
            unique: true,
            validate: v => v > this.periodStart
          },
          isFirstInSeries: {
            type: Boolean,
            default: false
          },
          tier: {
            type: "ObjectId",
            required: true
          },
          maxTotalSize: {
            type: Number,
            min: 0,
            set: v => Math.ceil(v),
            required: true,
            validate: v => v >= 1073741824
          },
          renewal: {
            type: {
              oldPeriod: {
                type: "ObjectId"
                // validate: () => !this.isFirstInSeries
              },
              reason: {
                type: String,
                trim: true
                // validate: () => !this.isFirstInSeries
              }
            }
          }
        }
      ],
      default: []
    },
    count: {
      type: Number,
      min: 0,
      default: 0
    }
  },
  log: {
    type: {
      activatedDate: {
        type: Number
      },
      deactivatedDate: {
        type: Number
      },
      canceledOn: {
        type: historyItemSchema
      }
    },
    // get rid of this once a log item has
    // an assigned default value
    default: {}
  }
});

module.exports = mongoose.model("Plan", planSchema);
