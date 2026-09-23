// A PlayStation-menu-style row of model cards -- pure DOM, no framework, matching this
// project's no-build-step convention. Visual language reuses the same active/hover treatment
// as the practice panel's .drill buttons (hologram.html), just laid out horizontally.
export function createCarousel({ mount, models, activeId, onSelect }) {
  mount.innerHTML = '';
  mount.classList.add('carousel');

  const buttons = new Map();

  for (const model of models) {
    const btn = document.createElement('button');
    btn.className = 'model-card';
    btn.dataset.id = model.id;
    btn.textContent = model.name;
    btn.disabled = model.id === activeId;
    btn.classList.toggle('active', model.id === activeId);
    btn.addEventListener('click', () => onSelect(model.id));
    mount.appendChild(btn);
    buttons.set(model.id, btn);
  }

  let currentActive = activeId;

  function applyDisabled() {
    for (const [modelId, btn] of buttons) {
      btn.disabled = mount.classList.contains('busy') || modelId === currentActive;
    }
  }

  return {
    setActive(id) {
      currentActive = id;
      for (const [modelId, btn] of buttons) btn.classList.toggle('active', modelId === id);
      applyDisabled();
    },
    // Swapping models is async (loadModel + full dispose/rebuild) -- disable every card for
    // the duration so a second click can't start a swap while one is already in flight.
    setBusy(busy) {
      mount.classList.toggle('busy', busy);
      applyDisabled();
    }
  };
}
