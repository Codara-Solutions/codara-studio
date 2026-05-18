function renderSummary(records) {
  return (records || [])
    .map((record) => `${record.team}: ${record.revenueCents}`)
    .join("\n");
}

module.exports = { renderSummary };
