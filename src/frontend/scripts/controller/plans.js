// plans ctrl
app.controller("plansCtrl", function($scope, $rootScope, $http, $interval) {
  const G = $rootScope.G;
  const User = G.clientModels.User;
  const Plan = G.clientModels.Plan;
  var stripe;

  // ---------------------------------------

  var stage = ($scope.stage = {
    status: "waiting"
  });

  var planList = [
    {
      id: "BASIC",
      img: "3-ring-icon",
      name: "3-ring",
      size: "100 Gb",
      price: 5,
      features: ["Archive at 50 GB/hr", "Retrieve at 25 GB/hr"],
      cycle: "monthly"
    },
    {
      id: "MID",
      img: "4-ring-icon",
      name: "4-ring",
      size: "300 Gb",
      price: 7,
      features: ["Archive at 150 GB/hr", "Retrieve at 50 GB/hr", "47% cheaper"],
      cycle: "monthly"
    },
    {
      id: "TOP",
      img: "5-ring-icon",
      name: "5-ring",
      size: "1000 Gb",
      price: 20,
      features: [
        "Restore old file versions",
        "Archive at 500 GB/hr",
        "Retrieve at 250 GB/hr",
        "40% cheaper"
      ],
      cycle: "monthly"
    }
  ];
  var plans = ($scope.plans = {
    list: planList,
    selected: planList[1],
    buyPlan: plan => {
      if (!G.user.email_verified) {
        return G.notifyError(
          "Please verify your email before purchasing a plan"
        );
      }
      if (G.user.plan && !G.user.plan.expired) {
        return G.notifyError("You already have an active plan");
      }
      G.notifyLoading(true);
      User.findOne({ _id: G.user._id }, { billing: 1 }, (err, user) => {
        G.notifyLoading(false);
        if (err || !user) {
          G.notifyError("Failed to load billing info", err);
        } else {
          billing.stage = "info";
          billing.plan = plan;
          billing.args = {
            ...billing.args,
            ...JSON.parse(JSON.stringify(user.billing))
          };
          billing.visible = true;
          billing.status = "";
        }
        $scope.$apply();
      });
    }
  });

  var billing = ($scope.billing = {
    visible: false,
    plan: {},
    stage: "info",
    status: "waiting",
    args: {
      firstName: "",
      lastName: "",
      address: {
        line1: "",
        line2: "",
        city: "",
        postal_code: "",
        country: "Canada"
      }
    },
    error: null,
    cancel: () => {
      billing.plan = {};
      billing.visible = false;
    },
    continueToStripe: () => {
      G.notifyLoading(true);
      billing.error = null;
      let checkTrimmedContent = obj => {
        for (const key in obj) {
          if (typeof obj[key] == "string") {
            obj[key] = obj[key].trim();
            if (obj[key].length == 0 && key != "line2") {
              return (billing.error = { msg: "Some fields are empty" });
            }
          } else if (checkTrimmedContent(obj[key])) {
            return true;
          }
        }
      };
      if (checkTrimmedContent(billing.args)) {
        return (G.notifyLoading(false));
      }
      if (
        !/^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/.test(
          billing.args.address.postal_code
        )
      ) {
        G.notifyLoading(false);
        return (billing.error = {
          cause: "postal-code",
          msg: "Invalid postal code"
        });
      }
      User.updateOne({ _id: G.user._id }, { billing: billing.args }, err => {
        G.notifyLoading(false);
        if (err) {
          billing.error = { msg: "Couldn't update your billing info" };
        } else {
          billing.stage = "stripe";
        }
        $scope.$apply();
      });
    },
    checkout: tokenId => {
      if (billing.status == "loading") return;
      billing.args.email = G.user.email;
      let billingLength =
        billing.plan.cycle == "monthly"
          ? 1
          : billing.plan.cycle == "quaterly"
          ? 4
          : 12;
      billing.status = "loading";
      console.log(G.user._id.toString());
      $http
        .post(
          `${G.API_DOMAIN}/client/plan/purchase`,
          {
            uid: G.user._id,
            tier: billing.plan.id,
            form: billing.args,
            length: billingLength,
            token: tokenId
          },
          G.oauthHeader()
        )
        .then(res => updateUserAndPlan())
        .catch(err => {
          if (err.status == 402) {
            err.data = err.data.data;
            if (err.data.status == "requires_payment_method") {
              return (billing.status = "declined");
            } else if (err.data.status == "requires_action") {
              stripe.handleCardPayment(err.data.reattempt).then(result => {
                if (result.error) {
                  billing.status = "";
                  delete err.data.reattempt;
                  // likely invalid authentication
                  G.notifyError("Your card was declined by your bank", err);
                } else {
                  updateUserAndPlan(err.data.plan, result);
                }
                $scope.$apply();
              });
              return;
            }
            delete err.data.reattempt;
          }
          console.error(err);
          billing.status = "error";
        });
      function updateUserAndPlan(plan, result) {
        User.findOne({ _id: G.user._id }, { plan: 1 }, (err, user) => {
          if (err) {
            G.notifyError(
              [
                "We couldn't update your user info. ",
                "Please ensure you are connected to the internet while using Binder. ",
                "Your account will be updated soon in the cloud."
              ],
              err
            );
            return $scope.$apply();
          }
          if (!user) {
            G.notifyError(
              [
                "Something has gone wrong while syncing your data. ",
                "Your plan has been purchased and will be activated soon in the cloud."
              ],
              err
            );
            return $scope.$apply();
          }
          Plan.updateOne(
            { _id: user.plan },
            {
              expired: false,
              "log.activatedDate": result
                ? result.paymentIntent.created || Date.now()
                : Date.now()
            },
            err => {
              if (err) {
                G.notifyError(
                  [
                    "We couldn't update your user info. ",
                    "Please ensure you are connected to the internet while using Binder. ",
                    "Your account will be updated soon in the cloud."
                  ],
                  err
                );
                return $scope.$apply();
              }
              onPaymentSuccess();
            }
          );
        });
      }
      function onPaymentSuccess() {
        billing.status = "success";
        $http
          .post(
            `${G.API_DOMAIN}/client/plan/provision`,
            {
              uid: G.user._id
            },
            G.oauthHeader()
          )
          .then(res => {
            billing.status = "";
            billing.restartCountdown = 10;
            let countdownTask = $interval(() => {
              if (--billing.restartCountdown == 0) {
                $interval.cancel(countdownTask);
                G.restart();
              }
            }, 1000);
          })
          .catch(err => {
            console.error(err);
            billing.status = "error";
          });
      }
    }
  });

  // ---------------------------------------

  stage.status = "loading";

  try {
    stripe = Stripe(G.stripePublishableKey);
  } catch (error) {
    stage.status = error;
    return console.error(error);
    // return G.notifyError("Something went wrong", error);
  }

  var elements = stripe.elements();

  // Custom styling can be passed to options when creating an Element.
  // (Note that this demo uses a wider set of styles than the guide below.)
  var style = {
    base: {
      color: "#32325d",
      fontFamily: '"Helvetica Neue", Helvetica, sans-serif',
      fontSmoothing: "antialiased",
      fontSize: "16px",
      "::placeholder": {
        color: "#aab7c4"
      }
    },
    invalid: {
      color: "#fa755a",
      iconColor: "#fa755a"
    }
  };

  // Create an instance of the card Element.
  var card = elements.create("card", {
    hidePostalCode: true,
    style: style
  });

  // Add an instance of the card Element into the `card-element` <div>.
  card.mount("#card-element");

  // Handle real-time validation errors from the card Element.
  card.addEventListener("change", function(event) {
    var displayError = document.getElementById("card-errors");
    if (event.error) {
      displayError.textContent = event.error.message;
    } else {
      displayError.textContent = "";
    }
  });

  // Handle form submission.
  var form = document.getElementById("payment-form");
  form.addEventListener("submit", function(event) {
    console.log("submitting");
    event.preventDefault();

    stripe.createToken(card).then(function(result) {
      if (result.error) {
        // Inform the user if there was an error.
        var errorElement = document.getElementById("card-errors");
        errorElement.textContent = result.error.message;
      } else {
        // Send the token to your server.
        stripeTokenHandler(result.token);
      }
    });
  });

  // Submit the form with the token ID.
  function stripeTokenHandler(token) {
    // Insert the token ID into the form so it gets submitted to the server
    var form = document.getElementById("payment-form");
    var hiddenInput = document.createElement("input");
    hiddenInput.setAttribute("type", "hidden");
    hiddenInput.setAttribute("name", "stripeToken");
    hiddenInput.setAttribute("value", token.id);
    form.appendChild(hiddenInput);

    // Submit the form
    // form.submit();
    // test token = "tok_visa"
    billing.checkout(token.id);
  }

  G.getUser((err, user) => {
    if (err || !user) {
      stage.status = "error";
      return G.notifyError("We couldn't get your user info", err);
    }
    G.user = user;
    stage.status = "";
    $scope.$apply();
  });
});
