/**
 * MixMaker · UI feedback helpers (toast notifications and screen-reader announcements).
 */
export function createUIFeedback(select) {
  function toast(message, type = 'info', action) {
    const element = document.createElement('div');
    element.className = 'toast ' + type;
    element.setAttribute('role', type === 'error' ? 'alert' : 'status');
    const text = document.createElement('span');
    text.textContent = message;
    element.append(text);
    if (action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      button.addEventListener('click', () => { action.fn(); element.remove(); });
      element.append(button);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '✕';
    close.setAttribute('aria-label', 'Cerrar aviso');
    close.addEventListener('click', () => element.remove());
    element.append(close);
    select('#toasts').append(element);
    setTimeout(() => element.remove(), type === 'error' ? 12000 : 6000);
  }

  function announce(message) {
    const live = select('#live');
    live.textContent = '';
    setTimeout(() => { live.textContent = message; }, 30);
  }

  return { toast, announce };
}
