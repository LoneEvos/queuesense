// Small stroke icons (24x24 grid, currentColor). Decorative: always aria-hidden.
const Svg = ({ children }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const CheckIcon = () => (
  <Svg>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Svg>
);

export const ClockIcon = () => (
  <Svg>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);

export const AlertIcon = () => (
  <Svg>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v6" />
    <path d="M12 17h.01" />
  </Svg>
);

// NFC: three arcs, like the radio waves printed on the stickers.
export const NfcIcon = () => (
  <Svg>
    <path d="M6 8.5a5 5 0 0 1 0 7" />
    <path d="M10 6a8.5 8.5 0 0 1 0 12" />
    <path d="M14 3.5a12 12 0 0 1 0 17" />
  </Svg>
);
