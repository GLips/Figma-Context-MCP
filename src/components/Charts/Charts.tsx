import React from 'react';
import styled from 'styled-components';

const ChartsContainer = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2rem;
  padding: 2rem;
  background: rgba(13, 17, 28, 0.95);
`;

const ChartCard = styled.div`
  background: rgba(19, 26, 42, 0.95);
  border-radius: 12px;
  padding: 1.5rem;
  border: 1px solid rgba(255, 255, 255, 0.1);
`;

const ChartTitle = styled.h3`
  color: #fff;
  font-size: 1.25rem;
  margin-bottom: 1rem;
`;

const ChartContent = styled.div`
  height: 300px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #666;
`;

const Charts: React.FC = () => {
  return (
    <ChartsContainer>
      <ChartCard>
        <ChartTitle>Cumulative Gas Per Pool</ChartTitle>
        <ChartContent>
          {/* Chart component will be integrated here */}
          Chart placeholder - Gas Per Pool
        </ChartContent>
      </ChartCard>
      
      <ChartCard>
        <ChartTitle>Total Gas Spent on Base</ChartTitle>
        <ChartContent>
          {/* Chart component will be integrated here */}
          Chart placeholder - Total Gas
        </ChartContent>
      </ChartCard>
    </ChartsContainer>
  );
};

export default Charts; 