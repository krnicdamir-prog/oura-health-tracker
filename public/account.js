const form = document.getElementById('invite-form');
const result = document.getElementById('invite-result');
const field = document.getElementById('invite-url');

form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  field.hidden = true;
  field.value = '';
  try {
    const response = await fetch('/api/invites', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({username: document.getElementById('invite-user').value})
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    field.value = new URL(body.invite, location.origin).href;
    field.hidden = false;
    field.focus();
    field.select();
    result.textContent = 'Kopiraj i pošalji poveznicu osobi koju pozivaš. Vrijedi 24 sata i može se upotrijebiti jednom.';
  } catch (error) {
    result.textContent = error.message || 'Pozivnica nije izrađena.';
  } finally {
    button.disabled = false;
  }
});
