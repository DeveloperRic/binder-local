var mongoose = require("mongoose");

var bucketSchema = mongoose.Schema({
  id: {
    type: String,
    index: true,
    trim: true,
    unique: true,
    uppercase: true
  },
  name: {
    type: String,
    trim: true,
    unique: true,
    required: true
  },
  b2_bucket_id: {
    type: String,
    unique: true
  }
}, {id: false});

var Bucket = (module.exports = mongoose.model("Bucket", bucketSchema));
