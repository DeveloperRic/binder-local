const mongoose = require("mongoose");

const userSchema = mongoose.Schema({
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
    type: "ObjectId"
  },
  profile: {
    type: Object,
    required: true
  },
  billing: {
    firstName: {
      type: String,
      trim: true,
      default: ""
    },
    lastName: {
      type: String,
      trim: true,
      default: ""
    },
    address: {
      line1: {
        type: String,
        trim: true,
        default: ""
      },
      line2: {
        type: String,
        trim: true,
        default: ""
      },
      city: {
        type: String,
        trim: true,
        default: ""
      },
      postal_code: {
        type: String,
        trim: true,
        validate: v => /^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/.test(v),
        default: ""
      },
      country: {
        type: String,
        trim: true,
        enum: ["Canada"]
      }
    }
  },
  stripe_customer_id: {
    type: String
  },
  security_key: {
    type: String,
    required: true
  },
  createdDate: {
    type: Number,
    default: () => Date.now()
  },
  pendingDeletion: {
    type: Boolean,
    default: false
  }
});

module.exports = mongoose.model("User", userSchema);
