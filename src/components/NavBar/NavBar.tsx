import React, { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { addPropertyControls, ControlType } from 'framer';

interface NavBarProps {
  backgroundColor: string;
  navItemColor: string;
  navItemHoverColor: string;
  buttonText: string;
  buttonTextColor: string;
  buttonBgColor: string;
  glowColor1: string;
  glowColor2: string;
  navFont: { fontFamily: string; fontWeight: number };
  buttonFont: { fontFamily: string; fontWeight: number };
  fontSize: number;
  buttonFontSize: number;
  width: number;
  resourceItems: string[];
}

const navStyles = {
  container: {
    backgroundColor: '#1C1C1C',
    borderRadius: '22px',
    padding: '16px 24px',
    display: 'flex',
    alignItems: 'center',
    fontFamily: 'Piazzolla, serif',
    minWidth: '366px',
    maxWidth: '400px',
    boxSizing: 'border-box' as const,
  },
  navGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    flex: 1,
  },
  navItems: {
    display: 'flex',
    gap: '16px',
    alignItems: 'center',
  },
  navItem: {
    position: 'relative',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
  },
  navText: {
    fontSize: '16px',
    lineHeight: 1.42,
    display: 'block',
    whiteSpace: 'nowrap' as const,
  },
  dropdown: {
    position: 'absolute',
    top: '100%',
    left: '0',
    marginTop: '8px',
    backgroundColor: '#1C1C1C',
    borderRadius: '12px',
    padding: '8px 0',
    minWidth: '160px',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
    zIndex: 10,
  },
  dropdownItem: {
    padding: '8px 16px',
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  dropdownIcon: {
    width: '20px',
    height: '20px',
  },
  ctaButton: {
    position: 'relative',
    border: 'none',
    borderRadius: '15px',
    padding: '11px 26px',
    fontFamily: 'Piazzolla, serif',
    fontSize: '16px',
    cursor: 'pointer',
    overflow: 'visible',
    whiteSpace: 'nowrap' as const,
    marginLeft: '16px',
    isolation: 'isolate',
  },
  buttonBackground: {
    position: 'absolute',
    inset: 0,
    backgroundColor: '#E9E8E3',
    borderRadius: '15px',
    zIndex: 2,
  },
  buttonContent: {
    position: 'relative',
    zIndex: 2,
    color: '#080808',
  },
  glowEffect: {
    position: 'absolute',
    width: '100%',
    height: '100%',
    borderRadius: '14px',
    filter: 'blur(22px)',
    pointerEvents: 'none',
    opacity: 0.4,
    zIndex: 1,
  },
  blueGlow: {
    left: '46px',
    top: '-4px',
    backgroundColor: '#75D7F5',
  },
  purpleGlow: {
    left: '4px',
    top: '-4px',
    backgroundColor: '#D59FFF',
  },
};

const resourceList = [
  {
    name: "tex1",
    type: "texture",
    path: "https://media-hosting.imagekit.io/aa5bc48db2884c12/screenshot_1744610153580.png"
  },
  {
    name: "tex2",
    type: "texture",
    path: "https://media-hosting.imagekit.io/c47ab90da85a438d/image%20(1).png"
  }
];

const spiralCount = 2;
const spiralImageCount = 1;

export function NavBar(props: NavBarProps) {
  const {
    backgroundColor,
    navItemColor,
    navItemHoverColor,
    buttonText,
    buttonTextColor,
    buttonBgColor,
    glowColor1,
    glowColor2,
    navFont,
    buttonFont,
    fontSize,
    buttonFontSize,
    width,
    resourceItems,
  } = props;

  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });
  const [isHovered, setIsHovered] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const handleMouseMove = (event: React.MouseEvent) => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * 100;
      const y = ((event.clientY - rect.top) / rect.height) * 100;
      setMousePosition({ x, y });
    }
  };

  const customStyles = {
    ...navStyles,
    container: {
      ...navStyles.container,
      backgroundColor,
      fontFamily: navFont.fontFamily,
      width: `${width}px`,
    },
    navText: {
      ...navStyles.navText,
      fontSize: `${fontSize}px`,
    },
    ctaButton: {
      ...navStyles.ctaButton,
      fontSize: `${buttonFontSize}px`,
      fontFamily: buttonFont.fontFamily,
    },
    buttonBackground: {
      ...navStyles.buttonBackground,
      backgroundColor: buttonBgColor,
    },
    buttonContent: {
      ...navStyles.buttonContent,
      color: buttonTextColor,
    },
    blueGlow: {
      ...navStyles.glowEffect,
      ...navStyles.blueGlow,
      backgroundColor: glowColor1,
    },
    purpleGlow: {
      ...navStyles.glowEffect,
      ...navStyles.purpleGlow,
      backgroundColor: glowColor2,
    },
  };

  return (
    <motion.nav style={customStyles.container}>
      <div style={customStyles.navGroup}>
        <div style={customStyles.navItems}>
          <motion.div 
            style={customStyles.navItem}
            onHoverStart={() => setIsDropdownOpen(true)}
            onHoverEnd={() => setIsDropdownOpen(false)}
          >
            <motion.span
              style={customStyles.navText}
              initial={{ color: navItemColor }}
              whileHover={{ color: navItemHoverColor }}
            >
              Resources
            </motion.span>
            <AnimatePresence>
              {isDropdownOpen && (
                <motion.div
                  style={customStyles.dropdown}
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.2 }}
                >
                  {resourceItems.map((item) => (
                    <motion.div
                      key={item}
                      style={customStyles.dropdownItem}
                      initial={{ color: navItemColor }}
                      whileHover={{ color: navItemHoverColor }}
                    >
                      {item}
                    </motion.div>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
          <motion.a
            href="#handbook"
            style={{ ...customStyles.navText, textDecoration: 'none' }}
            initial={{ color: navItemColor }}
            whileHover={{ color: navItemHoverColor }}
          >
            Handbook
          </motion.a>
        </div>
        <motion.button
          ref={buttonRef}
          style={customStyles.ctaButton}
          onMouseMove={handleMouseMove}
          onHoverStart={() => setIsHovered(true)}
          onHoverEnd={() => setIsHovered(false)}
          whileHover={{ y: -2 }}
          transition={{ type: "spring", stiffness: 400, damping: 17 }}
        >
          <motion.div
            style={customStyles.blueGlow}
            animate={{
              opacity: isHovered ? 0.6 : 0.4,
              x: isHovered ? mousePosition.x - 50 : 0,
              y: isHovered ? mousePosition.y - 50 : 0,
            }}
            transition={{ type: "spring", stiffness: 200, damping: 25 }}
          />
          <motion.div
            style={customStyles.purpleGlow}
            animate={{
              opacity: isHovered ? 0.6 : 0.4,
              x: isHovered ? mousePosition.x - 50 : 0,
              y: isHovered ? mousePosition.y - 50 : 0,
            }}
            transition={{ type: "spring", stiffness: 200, damping: 25 }}
          />
          <motion.div style={customStyles.buttonBackground} />
          <span style={customStyles.buttonContent}>
            {buttonText}
          </span>
        </motion.button>
      </div>
    </motion.nav>
  );
}

NavBar.defaultProps = {
  backgroundColor: '#1C1C1C',
  navItemColor: '#94938D',
  navItemHoverColor: '#FFFFFF',
  buttonText: 'Launch App',
  buttonTextColor: '#080808',
  buttonBgColor: '#E9E8E3',
  glowColor1: '#75D7F5',
  glowColor2: '#D59FFF',
  navFont: {
    fontFamily: "Piazzolla",
    fontWeight: 400,
  },
  buttonFont: {
    fontFamily: "Piazzolla",
    fontWeight: 400,
  },
  fontSize: 16,
  buttonFontSize: 16,
  width: 400,
  resourceItems: ['Documentation', 'API Reference', 'Tutorials', 'Blog'],
};

addPropertyControls(NavBar, {
  width: {
    type: ControlType.Number,
    title: "Width",
    min: 366,
    max: 400,
    step: 1,
  },
  backgroundColor: {
    type: ControlType.Color,
    title: "Background Color",
  },
  navItemColor: {
    type: ControlType.Color,
    title: "Nav Item Color",
  },
  navItemHoverColor: {
    type: ControlType.Color,
    title: "Nav Hover Color",
  },
  resourceItems: {
    type: ControlType.Array,
    title: "Resource Items",
    control: {
      type: ControlType.String,
    },
  },
  navFont: {
    type: ControlType.Font,
    title: "Nav Font",
  },
  fontSize: {
    type: ControlType.Number,
    title: "Font Size",
    min: 12,
    max: 32,
    step: 1,
  },
  buttonText: {
    type: ControlType.String,
    title: "Button Text",
  },
  buttonTextColor: {
    type: ControlType.Color,
    title: "Button Text Color",
  },
  buttonBgColor: {
    type: ControlType.Color,
    title: "Button Color",
  },
  buttonFont: {
    type: ControlType.Font,
    title: "Button Font",
  },
  buttonFontSize: {
    type: ControlType.Number,
    title: "Button Font Size",
    min: 12,
    max: 32,
    step: 1,
  },
  glowColor1: {
    type: ControlType.Color,
    title: "Glow Color 1",
  },
  glowColor2: {
    type: ControlType.Color,
    title: "Glow Color 2",
  },
}); 