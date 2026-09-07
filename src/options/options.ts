const form = document.querySelector<HTMLFormElement>('[data-settings-form]');

form?.addEventListener('submit', (event) => {
  event.preventDefault();
});
