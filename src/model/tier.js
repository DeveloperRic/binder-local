var mongoose = require("mongoose");

var tierSchema = mongoose.Schema({
  id: {
    type: String,
    index: true,
    unique: true,
    uppercase: true,
    required: true,
    enum: ["BASIC", "MID", "TOP"]
  },
  name: {
    type: String,
    trim: true,
    unique: true,
    required: true
  },
  pricePerMonth: {
    type: Number,
    min: 0,
    set: v => Math.ceil(v),
    required: true
  },
  maxTotalSize: {
    type: Number,
    min: 0,
    set: v => Math.ceil(v),
    required: true
  },
  defaultBlockSize: {
    type: Number,
    min: 0,
    set: v => Math.ceil(v),
    required: true
  },
  archiveSpeed: {
    type: Number,
    min: 1,
    set: v => Math.floor(v),
    required: true
  },
  retrieveSpeed: {
    type: Number,
    min: 1,
    set: v => Math.floor(v),
    required: true
  },
  fileVersioningAllowed: {
    type: Boolean,
    default: false
  },
  lifecycleRules: {
    deleteAfter: {
      type: Number,
      min: 1,
      set: v => Math.floor(v),
      default: 30
    }
  }
}, {id: false});

var Tier = (module.exports = mongoose.model("Tier", tierSchema));
