// Native disclosure keeps optional animation controls out of the composition.
const controls = document.querySelector('#interaction');
document.addEventListener('pointerdown', event => {
  if (controls.open && !controls.contains(event.target)) controls.open = false;
});
controls.addEventListener('keydown', event => {
  if (event.key === 'Escape' && controls.open) {
    controls.open = false;
    controls.querySelector('summary').focus();
  }
});
