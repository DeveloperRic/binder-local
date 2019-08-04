// my-binder ctrl
app.controller("myBinderCtrl", function($scope, $rootScope, $http) {
  const ip = require("ip");
  const G = $rootScope.G;
  var Block = G.clientModels.Block;
  var Tier = G.clientModels.Tier;

  // ---------------------------------------

  var stage = ($scope.stage = {
    status: "waiting"
  });

  var space = ($scope.space = {
    status: "waiting",
    retrieveBlock: blockId => {
      G.notifyError("Not implemented yet");
    },
    mergeBlock: subBlockId => {
      G.notifyChoose(
        "custom",
        {
          name: "Pick a block to merge into",
          children: space.blocks
            .filter(b => b.id != subBlockId && !b.mergedInto)
            .map(block => {
              return {
                id: block.id,
                name: `Block ${space.blocks.findIndex(b => b.id == block.id) +
                  1}     (${(block.usedRatio * 100).toFixed(1)}% used)`
              };
            })
        },
        mainBlockId => {
          if (!mainBlockId) return;
          if (
            !confirm(
              "Are you sure you want to do this? Merging blocks is a permanent operation, and can only be reversed (automatically) if a significant performance decrease is detected."
            )
          ) {
            return;
          }
          mainBlockId = mainBlockId.id;
          G.loadingPopup.visible = true;
          $http
            .post(
              `${G.API_DOMAIN}/client/plan/mergeBlocks`,
              {
                subBlock: subBlockId,
                mainBlock: mainBlockId,
                ipAddress:
                  ip.address("public", "ipv6") || ip.address("public", "ipv4")
              },
              G.oauthHeader()
            )
            .finally(() => (G.loadingPopup.visible = false))
            .then(() => {
              spaceRefresh()
                .then(() => $scope.$apply())
                .catch(info => {
                  G.notifyError(
                    [
                      "Your blocks were merged.",
                      "But the request failed when refreshing the list.",
                      "Please reopen the 'My Binder' page."
                    ],
                    info[1]
                  );
                });
            })
            .catch(err => G.notifyError("Failed to merge blocks", err));
        }
      );
    }
  });

  var plan = ($scope.plan = {
    status: "waiting"
  });

  // ---------------------------------------

  stage.status = "loading";

  G.getUser((err, user) => {
    if (err || !user) {
      stage.status = "error";
      G.notifyError("We couldn't get your user info", err);
      return $scope.$apply();
    }
    G.user = JSON.parse(JSON.stringify(user));
    if (!user.plan) {
      stage.status = "error";
      G.notifyError("Cannot show info without a plan");
    } else {
      Promise.all([spaceRefresh(), planRefresh()])
        .then(() => $scope.$apply(() => (stage.status = "")))
        .catch(args =>
          $scope.$apply(() => {
            console.log(args);
            stage.status = "error";
            G.notifyError(args[0], args[1]);
          })
        );
    }
    $scope.$apply();
  }, "plan", "stripe_customer_id");

  function spaceRefresh() {
    return new Promise((resolve, reject) => {
      space.status = "loading";
      let onGotBlocks = blocks => {
        let contextMenuHTML = (icon, text) =>
          "<span class='context-menu-item'><i class='material-icons'>" +
          icon +
          "</i>" +
          text +
          "</span>";
        space = $scope.space = Object.assign(space, {
          usedStorage: G.user.plan.latestTotalSize / 1073741824,
          maxStorage: G.user.plan.maxTotalSize / 1073741824,
          blocks: blocks.map(block => {
            let blockObj = {
              id: block._id,
              usedStorage: block.latestSize / 1073741824,
              fileCount: block.fileCount,
              contextMenu: [
                {
                  html: contextMenuHTML("file_download", "Download block"),
                  click: () => space.retrieveBlock(block._id)
                },
                {
                  html: contextMenuHTML("merge_type", "Merge into"),
                  displayed: !(block.mergedInto || block.mergedWith),
                  click: () => space.mergeBlock(block._id)
                },
                {
                  html: contextMenuHTML("live_help", "What's this?"),
                  displayed: Boolean(block.mergedInto),
                  click: () =>
                    alert(
                      "This block has been marked as 'merged' into another block.\nWhich means that new files set to go into this block will no longer be stored here, but instead in the block's parent block.\nFor more help, check the Help page."
                    )
                }
              ]
            };
            if (block.mergedInto) {
              blockObj.mergedInto = block.mergedInto;
            }
            let usedRatio = (blockObj.usedRatio =
              blockObj.usedStorage / block.maxSize).toFixed(2);
            if (usedRatio > 0) {
              blockObj.graphicClass = `{'flex-grow': ${usedRatio}}`;
            } else {
              blockObj.graphicClass = "{'flex-grow': 0.01}";
            }
            return blockObj;
          })
        });
        let usedRatio = (space.usedStorage / space.maxStorage).toFixed(2);
        if (usedRatio > 0) {
          space.graphicClass = `{'flex-grow': ${usedRatio}}`;
        } else {
          space.graphicClass = "{'flex-grow': 0.01}";
        }
        space.status = "";
        resolve();
      };
      Block.find(
        { _id: { $in: G.user.plan.blocks } },
        {
          latestSize: 1,
          maxSize: 1,
          mergedInto: 1,
          mergedWith: 1,
          fileCount: 1
        },
        (err, blocks2) => {
          if (err) {
            space.status = "error";
            return reject(["Couldn't get your info", err]);
          } else {
            blocks2 = JSON.parse(JSON.stringify(blocks2));
            for (let i in blocks2) {
              let b = blocks2[i];
              if (b.mergedInto) {
                b.mergedInto = true;
              } else {
                delete b.mergedInto;
              }
              b.mergedWith = b.mergedWith.length > 0;
            }
            onGotBlocks(blocks2);
          }
        }
      ).lean(true);
    });
  }

  function planRefresh() {
    return new Promise((resolve, reject) => {
      Tier.findOne({ id: G.user.plan.tier }, { name: 1 }, (err, tier) => {
        if (err || !tier) {
          plan.status = "error";
          return reject([
            "Couldn't get your info",
            err || new Error("Tier not found")
          ]);
        }
        let planCycle = "";
        switch (G.user.plan.lengthInMonths) {
          case 1:
            planCycle = "MONTHLY";
            break;
          case 4:
            planCycle = "QUATERLY";
            break;
          case 12:
            planCycle = "ANUALLY";
            break;
          default:
            planCycle = `EVERY ${G.user.plan.lengthInMonths} MONTHS`;
        }
        plan = $scope.plan = Object.assign(plan, {
          name: tier.name,
          cycle: planCycle,
          nextPayment: "Unknown", // NOT ACCEPTABLE
          invoiceHistory: []
        });
        let formatDate = date => {
          return `${date.getDate()} 
          ${G.longMonths[date.getMonth()]} ${date.getFullYear()}`;
        };
        let periodEnd = new Date(G.user.plan.currentPeriodStart);
        periodEnd.setFullYear(
          periodEnd.getFullYear() + Math.floor(G.user.plan.lengthInMonths / 12)
        );
        periodEnd.setMonth(
          (periodEnd.getMonth() + G.user.plan.lengthInMonths) % 12
        );
        plan.nextPayment = formatDate(periodEnd);
        $http
          .get(
            `${G.API_DOMAIN}/client/plan/invoiceHistory`,
            G.oauthHeader({
              params: {
                subscription: G.user.plan.stripe_subscription_id,
                map: ["id", "created", "total"]
              }
            })
          )
          .then(({ data }) => {
            let invoiceHistory = data;
            let invoices = [];
            console.log(invoiceHistory);
            plan.invoiceHistory = invoiceHistory.map(invoice => {
              invoices.push({
                id: invoice.id,
                created: invoice.created
              });
              console.log(invoice);
              return {
                id: invoice.id,
                formattedDate: formatDate(new Date(invoice.created * 1000)),
                price: invoice.total / 100,
                card: {}
              };
            });
            $http
              .get(
                `${G.API_DOMAIN}/client/plan/cardForInvoice`,
                G.oauthHeader({
                  params: {
                    invoices: invoices,
                    customer: G.user.stripe_customer_id
                  }
                })
              )
              .then(({ data }) => {
                let cards = data;
                console.log(cards);
                for (const invoice in cards) {
                  let item = plan.invoiceHistory.find(v => v.id == invoice);
                  if (!item) continue;
                  item.card.img = cards[invoice].brand;
                  item.card.number = `●●●● ●●●● ●●●● ${cards[invoice].last4}`;
                }
                resolve();
              })
              .catch(err => reject(["Couldn't get your invoice history", err]));
          })
          .catch(err => reject(["Couldn't get your invoice history", err]));
      });
    });
  }
});
