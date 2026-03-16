import React, { useState } from 'react';
import styled from 'styled-components';

const TradingContainer = styled.div`
  background: rgba(13, 17, 28, 0.95);
  border-radius: 12px;
  padding: 1.5rem;
  margin: 2rem;
`;

const TabContainer = styled.div`
  display: flex;
  gap: 1rem;
  margin-bottom: 1.5rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
`;

const Tab = styled.button<{ active: boolean }>`
  background: none;
  border: none;
  color: ${props => props.active ? '#fff' : '#666'};
  font-size: 1rem;
  padding: 0.5rem 1rem;
  cursor: pointer;
  position: relative;

  &::after {
    content: '';
    position: absolute;
    bottom: -1px;
    left: 0;
    right: 0;
    height: 2px;
    background: ${props => props.active ? '#5B7E91' : 'transparent'};
  }

  &:hover {
    color: #fff;
  }
`;

const OrderForm = styled.form`
  display: flex;
  flex-direction: column;
  gap: 1rem;
`;

const InputGroup = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
`;

const Label = styled.label`
  color: #666;
  font-size: 0.875rem;
`;

const Input = styled.input`
  background: rgba(19, 26, 42, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  padding: 0.75rem;
  color: #fff;
  font-size: 1rem;

  &:focus {
    outline: none;
    border-color: #5B7E91;
  }
`;

const SubmitButton = styled.button`
  background: linear-gradient(169.93deg, #5B7E91 0%, #9ED6F4 100%);
  border: none;
  border-radius: 6px;
  padding: 0.75rem;
  color: #21273D;
  font-weight: bold;
  cursor: pointer;
  margin-top: 1rem;

  &:hover {
    opacity: 0.9;
  }
`;

const TradingInterface: React.FC = () => {
  const [activeTab, setActiveTab] = useState('market');

  return (
    <TradingContainer>
      <TabContainer>
        <Tab 
          active={activeTab === 'market'} 
          onClick={() => setActiveTab('market')}
        >
          Market
        </Tab>
        <Tab 
          active={activeTab === 'limit'} 
          onClick={() => setActiveTab('limit')}
        >
          Limit
        </Tab>
        <Tab 
          active={activeTab === 'history'} 
          onClick={() => setActiveTab('history')}
        >
          Trade History
        </Tab>
      </TabContainer>

      {activeTab === 'market' && (
        <OrderForm>
          <InputGroup>
            <Label>Amount</Label>
            <Input type="number" placeholder="0.00" />
          </InputGroup>
          <InputGroup>
            <Label>Price</Label>
            <Input type="number" placeholder="Market Price" disabled />
          </InputGroup>
          <SubmitButton type="submit">Place Market Order</SubmitButton>
        </OrderForm>
      )}

      {activeTab === 'limit' && (
        <OrderForm>
          <InputGroup>
            <Label>Amount</Label>
            <Input type="number" placeholder="0.00" />
          </InputGroup>
          <InputGroup>
            <Label>Limit Price</Label>
            <Input type="number" placeholder="0.00" />
          </InputGroup>
          <SubmitButton type="submit">Place Limit Order</SubmitButton>
        </OrderForm>
      )}

      {activeTab === 'history' && (
        <div style={{ color: '#666', textAlign: 'center', padding: '2rem' }}>
          No trade history available
        </div>
      )}
    </TradingContainer>
  );
};

export default TradingInterface; 