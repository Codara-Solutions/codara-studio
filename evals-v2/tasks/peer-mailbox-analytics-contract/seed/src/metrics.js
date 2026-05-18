function normalizeRecords(records) {
  return (records || []).map((record) => ({
    team: record.team,
    revenueCents: Number(record.revenueCents || 0),
    costCents: Number(record.costCents || 0),
  }));
}

module.exports = { normalizeRecords };
