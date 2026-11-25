/**
 * MixMaker · Inspector field markup.
 * The property definitions stay in app.js because they depend on the active project model.
 */
export function renderInspectorField(definition, object, prefix, escapeHTML) {
  const id = `f_${prefix}_${definition.k}`;
  const value = definition.get(object);
  const dataAttribute = `data-d="${prefix}|${definition.k}"`;
  const label = `<label for="${id}">${escapeHTML(definition.label)}</label>`;

  if (definition.type === 'check') {
    return `<div class="fl">${label}<input type="checkbox" id="${id}" ${dataAttribute} ${value ? 'checked' : ''}><span></span></div>`;
  }
  if (definition.type === 'select') {
    const options = definition.opts.map(([optionValue, optionLabel]) =>
      `<option value="${optionValue}" ${optionValue === value ? 'selected' : ''}>${escapeHTML(optionLabel)}</option>`
    ).join('');
    return `<div class="fl">${label}<select id="${id}" ${dataAttribute}>${options}</select><span></span></div>`;
  }
  if (definition.type === 'text') {
    return `<div class="fl">${label}<input type="text" id="${id}" ${dataAttribute} maxlength="60" value="${escapeHTML(value)}"><span></span></div>`;
  }
  if (definition.type === 'number') {
    return `<div class="fl">${label}<input type="number" id="${id}" ${dataAttribute} min="${definition.min}" step="${definition.step}" value="${value}"><span></span></div>`;
  }
  return `<div class="fl">${label}<input type="range" id="${id}" ${dataAttribute} min="${definition.min}" max="${definition.max}" step="${definition.step}" value="${value}"><output for="${id}">${definition.out ? definition.out(value) : value}</output></div>`;
}
