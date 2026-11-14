import { startJefe } from './jefe.js';
import { startPantalla } from './pantalla.js';
import { startPortada } from './portada.js';

const q = new URLSearchParams(location.search);
const g = (q.get('g') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const root = document.getElementById('app');

if (g && q.get('t')) {
  document.title = `Jefes · ${g} · Lobos en el parque`;
  startJefe(root, g, q.get('t'));
} else if (g && q.get('p')) {
  document.title = `Pantalla · ${g} · Lobos en el parque`;
  document.body.classList.add('public');
  startPantalla(root, g, q.get('p'));
} else {
  startPortada(root);
}
