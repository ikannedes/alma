// Editor del cuadro actual y de todo el movimiento. Cada campo se edita sobre la forma alma-anim/1 del cuadro y vuelve
// a cuadro con fromAnim: el panel y el JSON nunca se contradicen.
const FIELDS = {
  pose: ['S0', 'S1', 'S2', 'S3'],
  caminar: ['ciclos', 'T', 'caderas', 'pies', 'desvio', 'fase'],
  girar: ['ciclos', 'T', 'cadera_a', 'cadera_b', 'pies', 'desvio', 'fase'],
  balanceo: ['ciclos', 'T', 'altura', 'fase'],
};
const DIRS = {
  caminar: ['adelante', 'atras', 'sitio', 'adelante_y_neutro', 'atras_y_neutro'],
  girar: ['izquierda', 'derecha', 'izquierda_y_neutro', 'derecha_y_neutro'],
};
const ANIM = 'alma-anim/1';

export function setupEditor({ $, engine, get, change, revert, add }) {
  const { buildMot, toAnim, fromAnim, scaleTime, mirror, scaleAmplitude, parseMot } = engine;
  const curK = () => { const { cur, cursor } = get(); return cur && cur.tl.length ? cur.tl[Math.min(cursor, cur.tl.length - 1)].k : 0; };
  const one = (c) => fromAnim({ formato: ANIM, cuadros: [c] })[0];

  function render() {
    const { cur } = get();
    if (!cur) return;
    const k = curK();
    const c = toAnim(cur.name, [cur.frames[k]]).cuadros[0];
    const num = (key, v) => `<label>${key} <input data-f="${key}" type="number" value="${v}" step="${key === 'ciclos' ? 0.5 : 1}" style="width:68px" /></label>`;
    let html = `<p class="hint">cuadro ${k + 1} de ${cur.frames.length}</p>`;
    let kind = null;
    if (c.pose) html += FIELDS.pose.map((n, i) => num(n, c.pose[i])).join(' ') + ' ' + num('ms', c.ms);
    else if (c.pausa !== undefined) html += num('pausa', c.pausa);
    else if ((kind = Object.keys(c).find((x) => FIELDS[x]))) {
      html += `<b>${kind}</b><br>${FIELDS[kind].map((n) => num(n, c[kind][n])).join(' ')}`;
      if (DIRS[kind]) html += ` <label>dir <select data-f="dir">${DIRS[kind].map((d) => `<option ${d === c[kind].dir ? 'selected' : ''}>${d}</option>`).join('')}</select></label>`;
    } else html += '<p class="hint">tipo sin editor: pasa intacto</p>';
    const box = $('edit');
    box.innerHTML = html;
    box.onchange = (e) => {
      const key = e.target.dataset.f;
      if (!key) return;
      const v = key === 'dir' ? e.target.value : +e.target.value;
      const nc = JSON.parse(JSON.stringify(c));
      if (nc.pose) { const i = FIELDS.pose.indexOf(key); if (i >= 0) nc.pose[i] = v; else nc.ms = v; }
      else if (nc.pausa !== undefined) nc.pausa = v;
      else nc[kind][key] = v;
      let f;
      try { f = one(nc); } catch (err) { $('errs').textContent = err.message; return; }
      const frames = get().cur.frames.slice();
      frames[k] = f;
      change(frames, k);
    };
    $('errs').textContent = cur.errs.length
      ? `No se puede exportar:\n${cur.errs.slice(0, 8).map((x) => `cuadro ${x.k + 1}: ${x.msg}`).join('\n')}${cur.errs.length > 8 ? `\n… y ${cur.errs.length - 8} más` : ''}`
      : `Válido: ${cur.frames.length} cuadros, ${(cur.dur / 1000).toFixed(2)} s.`;
  }

  function insert(c) {
    const { cur } = get();
    if (!cur) { add('nuevo', [one(c)]); return; }
    const k = curK() + 1, frames = cur.frames.slice();
    frames.splice(k, 0, one(c));
    change(frames, k);
  }
  const nowPose = () => { const { cur, cursor } = get(); return cur && cur.tl.length ? cur.tl[cursor].s.map(Math.round) : [90, 90, 90, 90]; };
  const edit = (fn) => () => { const { cur } = get(); if (cur) fn(cur, curK()); };

  $('addPose').onclick = () => insert({ pose: nowPose(), ms: 300 });
  $('addWalk').onclick = () => insert({ caminar: { ciclos: 2, T: 800, caderas: 15, pies: 10, desvio: 0, fase: 0, dir: 'adelante' } });
  $('addTurn').onclick = () => insert({ girar: { ciclos: 2, T: 800, cadera_a: 12, cadera_b: -12, pies: 10, desvio: 0, fase: 0, dir: 'izquierda' } });
  $('dup').onclick = edit((cur, k) => { const fr = cur.frames.slice(); fr.splice(k + 1, 0, { ...fr[k] }); change(fr, k + 1); });
  $('del').onclick = edit((cur, k) => { if (cur.frames.length < 2) return; const fr = cur.frames.slice(); fr.splice(k, 1); change(fr, Math.max(0, k - 1)); });
  $('up').onclick = edit((cur, k) => { if (k < 1) return; const fr = cur.frames.slice(); [fr[k - 1], fr[k]] = [fr[k], fr[k - 1]]; change(fr, k - 1); });
  $('down').onclick = edit((cur, k) => { if (k + 1 >= cur.frames.length) return; const fr = cur.frames.slice(); [fr[k + 1], fr[k]] = [fr[k], fr[k + 1]]; change(fr, k + 1); });
  $('mirror').onclick = edit((cur, k) => change(mirror(cur.frames), k));
  $('tApply').onclick = edit((cur, k) => change(scaleTime(cur.frames, +$('tk').value), k));
  $('aApply').onclick = edit((cur, k) => change(scaleAmplitude(cur.frames, +$('ak').value), k));
  $('revert').onclick = edit(() => revert());
  $('new').onclick = () => add(`nuevo_${get().files.filter((f) => f.name.startsWith('nuevo')).length + 1}`, [one({ pose: [90, 90, 90, 90], ms: 500 })]);

  function download(name, data, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  $('expMot').onclick = edit((cur) => {
    if (cur.errs.length) { render(); return; }
    const bytes = buildMot(cur.frames), back = parseMot(bytes);   // se vuelve a leer antes de bajarlo, como mot_studio
    if (back.bad || back.frames.length !== cur.frames.length) { $('errs').textContent = 'Error interno: el .mot exportado no se vuelve a leer igual.'; return; }
    download(`${cur.name}${cur.edited ? '_editado' : ''}.mot`, bytes, 'application/octet-stream');
  });
  $('expJson').onclick = edit((cur) => download(`${cur.name}.json`, JSON.stringify(toAnim(cur.name, cur.frames), null, 1), 'application/json'));
  $('impJson').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { const anim = JSON.parse(await f.text()); add(anim.nombre || f.name.replace(/\.json$/i, ''), fromAnim(anim)); }
    catch (err) { $('errs').textContent = `No pude leer ${f.name}: ${err.message}`; }
    e.target.value = '';
  };
  return { render };
}
