const { totalCents } = require("./pricing");

function renderInvoice(lines) {
  const rows = lines.map((line) => `${line.name}: $${(line.cents / 100).toFixed(2)}`);
  rows.push(`Total: $${(totalCents(lines) / 100).toFixed(2)}`);
  return rows.join("\n");
}

module.exports = { renderInvoice };

