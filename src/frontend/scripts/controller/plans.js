// plans ctrl
app.controller("plansCtrl", function($scope, $rootScope, $http, $interval) {
  const G = $rootScope.G;
  const { purchaseEndpoint } = G.paymentService;
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
      if (G.user.plan && G.user.plan.active) {
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
    stripeReady: false,
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
        return G.notifyLoading(false);
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
      if (!billing.stripeReady) {
        return G.notifyError("Our payment system is taking a while to start");
      }
      billing.args.email = G.user.email;
      let billingLength =
        billing.plan.cycle == "monthly"
          ? 1
          : billing.plan.cycle == "quaterly"
          ? 4
          : 12;
      billing.status = "loading";
      purchaseEndpoint(
        stripe,
        {
          userId: G.user._id,
          tier: billing.plan.id,
          form: billing.args,
          length: billingLength,
          token: tokenId
        },
        true,
        {
          onDeclined: err => {
            if (err) {
              billing.status = "";
              G.notifyError("Your card was declined by your bank", err);
            } else {
              billing.status = "declined";
            }
            $scope.$apply();
          },
          onUpdateError: err => {
            billing.status = "";
            G.notifyError(
              [
                "Something's gone wrong while syncing your data. ",
                "Your plan has been purchased and will be activated soon in the cloud."
              ],
              err
            );
            $scope.$apply();
          },
          onBeforeProvision: () => {
            billing.status = "success";
            $scope.$apply();
          },
          onProvisionError: err => {
            billing.status = "";
            G.notifyError(
              [
                "Something's gone wrong while provisioning your storage. ",
                "Your plan has been purchased and will be provisioned soon in the cloud."
              ],
              err
            );
            $scope.$apply();
          },
          onUnknownError: err => {
            console.error(err);
            billing.status = "error";
            $scope.$apply();
          },
          onSuccess: () => {
            billing.status = "";
            billing.restartCountdown = 10;
            let countdownTask = $interval(() => {
              if (--billing.restartCountdown == 0) {
                $interval.cancel(countdownTask);
                G.restart();
              }
            }, 1000);
          }
        }
      );
    }
  });

  // ---------------------------------------

  stage.status = "loading";

  G.initialiseStripe(document, "#card-element", billing.checkout)
    .then(_stripe => {
      stripe = _stripe;
      billing.stripeReady = true;
    })
    .catch(err => {
      stage.status = err;
      return console.error(err);
      // return G.notifyError("Something went wrong", error);
    });

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
