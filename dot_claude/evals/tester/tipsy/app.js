import { calculateTip } from './src/tip.js';

const $ = (id) => document.getElementById(id);

$('calc').addEventListener('click', () => {
  const bill = parseFloat($('bill').value);
  const percent = parseFloat($('percent').value);
  const split = parseInt($('split').value, 10);

  const { tip, total, perPerson } = calculateTip(bill, percent, split);

  $('result').hidden = false;
  $('tip').textContent = `$${tip.toFixed(2)}`;
  $('total').textContent = `$${total.toFixed(2)}`;
  $('per-person').textContent = `$${perPerson.toFixed(2)}`;
});
