import React from 'react';
import styled from 'styled-components';

const LogoContainer = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  background: #3E332E;
  border-radius: 80px;
  position: relative;
`;

const LogoImage = styled.img`
  width: 100%;
  height: 100%;
  position: absolute;
  top: 0;
  left: 0;
`;

const LogoRing = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  border: 0.77px solid #FFFFFF;
  border-radius: 80px;
`;

export const Logo: React.FC = () => {
  const logoImages = Array.from({ length: 9 }, (_, i) => {
    try {
      return require(`./assets/logo-vector-${i + 1}.svg`);
    } catch (e) {
      console.warn(`Failed to load logo-vector-${i + 1}.svg`);
      return null;
    }
  }).filter(Boolean);

  return (
    <LogoContainer>
      {logoImages.map((src, index) => (
        <LogoImage
          key={index}
          src={src}
          alt={`Logo part ${index + 1}`}
        />
      ))}
      <LogoRing />
    </LogoContainer>
  );
}; 