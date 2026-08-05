export function calculateTip(bill, percent, split) {
  const tip = bill * (percent / 100);
  const total = bill + tip;
  const perPerson = Math.floor((total / split) * 100) / 100;
  return { tip, total, perPerson };
}
