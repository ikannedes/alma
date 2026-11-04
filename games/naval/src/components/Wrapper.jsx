import { IntlProvider } from 'react-intl';
import Spanish from '../lang/es-ES.json';

// Solo español (se quitaron inglés y chino y el selector de idioma del original).
const Wrapper = ({ children }) => (
  <IntlProvider messages={Spanish} locale='es-ES' defaultLocale='es-ES'>
    {children}
  </IntlProvider>
);

export default Wrapper;
