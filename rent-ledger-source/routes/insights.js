// Cash-flow insights and review alerts.
const insights = require("../services/insights");
const { rupeesDeep } = require("./finance");
const { requirePermission } = require("./common");

function register(app, { db, todayFor }) {
  app.get("/api/insights/cashflow", requirePermission("reports.view"), (req, res) => {
    res.json(rupeesDeep(insights.cashflow(db, req.orgId, todayFor(req))));
  });
  app.get("/api/insights/anomalies", requirePermission("reports.view"), (req, res) => {
    res.json(insights.anomalies(db, req.orgId, todayFor(req)));
  });
}

module.exports = { register };
