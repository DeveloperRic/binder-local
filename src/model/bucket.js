const mongoose = require("mongoose");

const bucketSchema = mongoose.Schema(
  {
    id: {
      type: String,
      index: true,
      trim: true,
      unique: true,
      uppercase: true,
      required: true
    },
    name: {
      type: String,
      trim: true,
      unique: true,
      required: true
    },
    b2_bucket_id: {
      type: String,
      unique: true,
      sparse: true
    },
    lifecycleRules: {
      deleteAfter: {
        type: Number,
        min: 1,
        set: v => Math.floor(v),
        default: 30
      }
    }
  },
  { id: false }
);

module.exports = mongoose.model("Bucket", bucketSchema);
