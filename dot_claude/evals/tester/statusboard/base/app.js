const btn = document.getElementById('refresh');
const updated = document.querySelector('.updated');

btn.addEventListener('click', () => {
  updated.textContent = `Last updated ${new Date().toLocaleTimeString()}.`;
});
