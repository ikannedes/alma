import { FormattedMessage } from 'react-intl';

// Portada (adaptado de Welcome.jsx del repo): sin nombres, modos, dificultad ni idioma; el rival siempre es Alma.
// La imagen del original (shipGroup.png, origen desconocido) se cambió por un dibujo SVG propio.
const Welcome = ({ onStart, busy }) => (
  <section className='welcome'>
    <svg className='welcome-art' viewBox='0 0 120 72' aria-hidden='true'>
      <path d='M14 44h92l-12 16H26z' fill='#4f6d93' />
      <rect x='40' y='30' width='34' height='14' rx='2' fill='#c9d6e8' />
      <rect x='50' y='18' width='6' height='12' fill='#8aa1bf' />
      <rect x='62' y='22' width='6' height='8' fill='#8aa1bf' />
      <path d='M74 38h22' stroke='#c9d6e8' strokeWidth='3' strokeLinecap='round' />
      <path d='M4 64q8-6 16 0t16 0 16 0 16 0 16 0 16 0 16 0' fill='none' stroke='#5fb4e6' strokeWidth='3' />
    </svg>
    <h1 className='welcome-title'>
      <FormattedMessage id='welcome.title' />
    </h1>
    <p className='welcome-intro'>
      <FormattedMessage id='welcome.introduction' />
    </p>
    <button type='button' className='btn btn-main btn-big' onClick={onStart} disabled={busy}>
      <FormattedMessage id={busy ? 'welcome.connecting' : 'welcome.start'} />
    </button>
  </section>
);

export default Welcome;
