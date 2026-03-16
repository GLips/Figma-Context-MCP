import React from 'react';
import styled from 'styled-components';

const PoolDataContainer = styled.div`
  background: rgba(13, 17, 28, 0.95);
  border-radius: 12px;
  padding: 1.5rem;
  margin: 2rem;
`;

const Title = styled.h2`
  color: #fff;
  font-size: 1.5rem;
  margin-bottom: 1.5rem;
`;

const DataGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1.5rem;
`;

const DataCard = styled.div`
  background: rgba(19, 26, 42, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  padding: 1rem;
`;

const Period = styled.div`
  color: #666;
  font-size: 0.875rem;
  margin-bottom: 0.5rem;
`;

const Volume = styled.div`
  color: #fff;
  font-size: 1.25rem;
  font-weight: bold;
`;

const Change = styled.div<{ positive: boolean }>`
  color: ${props => props.positive ? '#4CAF50' : '#F44336'};
  font-size: 0.875rem;
  margin-top: 0.5rem;
`;

interface PoolDataProps {
  data?: {
    period: string;
    volume: string;
    change: number;
  }[];
}

const defaultData = [
  {
    period: '24h',
    volume: '1,234.56 ETH',
    change: 5.67
  },
  {
    period: '7d',
    volume: '8,765.43 ETH',
    change: -2.34
  },
  {
    period: '30d',
    volume: '45,678.90 ETH',
    change: 12.45
  },
  {
    period: 'All Time',
    volume: '234,567.89 ETH',
    change: 45.67
  }
];

const HistoricalPoolData: React.FC<PoolDataProps> = ({ data = defaultData }) => {
  return (
    <PoolDataContainer>
      <Title>Historical Pool Data</Title>
      <DataGrid>
        {data.map((item, index) => (
          <DataCard key={index}>
            <Period>{item.period}</Period>
            <Volume>{item.volume}</Volume>
            <Change positive={item.change >= 0}>
              {item.change >= 0 ? '+' : ''}{item.change}%
            </Change>
          </DataCard>
        ))}
      </DataGrid>
    </PoolDataContainer>
  );
};

export default HistoricalPoolData; 