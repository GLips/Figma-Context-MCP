import React from 'react';
import styled from 'styled-components';

const LayoutWrapper = styled.div`
  min-height: 100vh;
  position: relative;
  overflow-x: hidden;
`;

const TextureOverlay = styled.div`
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-image: url('/src/assets/texture-overlay.png');
  background-repeat: repeat;
  background-size: 400px;
  opacity: 0.15;
  mix-blend-mode: soft-light;
  pointer-events: none;
  z-index: 0;
`;

const Content = styled.div`
  position: relative;
  z-index: 1;
`;

interface LayoutProps {
  children: React.ReactNode;
}

export const Layout: React.FC<LayoutProps> = ({ children }) => {
  return (
    <LayoutWrapper>
      <TextureOverlay />
      <Content>{children}</Content>
    </LayoutWrapper>
  );
}; 