import { createGlobalStyle } from 'styled-components';

export const GlobalStyles = createGlobalStyle`
  html, body {
    margin: 0;
    padding: 0;
    min-height: 100vh;
    font-family: 'Inter', system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
    background: #111019;
    color: #ffffff;
  }

  #root {
    min-height: 100vh;
    position: relative;
  }

  * {
    box-sizing: border-box;
  }

  button, input, select, textarea {
    font: inherit;
  }
`; 