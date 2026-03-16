import React from 'react';
import styled from 'styled-components';

const RevenueContainer = styled.div`
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

const MetricsGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 1.5rem;
`;

const MetricCard = styled.div`
  background: rgba(19, 26, 42, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  padding: 1.5rem;
`;

const MetricLabel = styled.div`
  color: #666;
  font-size: 0.875rem;
  margin-bottom: 0.5rem;
`;

const MetricValue = styled.div`
  color: #fff;
  font-size: 1.5rem;
  font-weight: bold;
  margin-bottom: 0.5rem;
`;

const MetricChange = styled.div<{ positive: boolean }>`
  color: ${props => props.positive ? '#4CAF50' : '#F44336'};
  font-size: 0.875rem;
  display: flex;
  align-items: center;
  gap: 0.25rem;
`;

const Projection = styled.div`
  color: #9ED6F4;
  font-size: 0.875rem;
  margin-top: 0.5rem;
  font-style: italic;
`;

interface RevenueMetric {
  label: string;
  value: string;
  change: number;
  projection?: string;
}

interface BaseRevenueProps {
  metrics?: RevenueMetric[];
}

const defaultMetrics: RevenueMetric[] = [
  {
    label: 'Daily Revenue',
    value: '156.78 ETH',
    change: 12.34,
    projection: 'Projected: 180.00 ETH'
  },
  {
    label: 'Weekly Revenue',
    value: '1,234.56 ETH',
    change: -5.67,
    projection: 'Projected: 1,400.00 ETH'
  },
  {
    label: 'Monthly Revenue',
    value: '5,678.90 ETH',
    change: 23.45,
    projection: 'Projected: 6,000.00 ETH'
  }
];

const BaseRevenue: React.FC<BaseRevenueProps> = ({ metrics = defaultMetrics }) => {
  return (
    <RevenueContainer>
      <Title>Base Revenue Metrics</Title>
      <MetricsGrid>
        {metrics.map((metric, index) => (
          <MetricCard key={index}>
            <MetricLabel>{metric.label}</MetricLabel>
            <MetricValue>{metric.value}</MetricValue>
            <MetricChange positive={metric.change >= 0}>
              {metric.change >= 0 ? '↑' : '↓'} {Math.abs(metric.change)}%
            </MetricChange>
            {metric.projection && (
              <Projection>{metric.projection}</Projection>
            )}
          </MetricCard>
        ))}
      </MetricsGrid>
    </RevenueContainer>
  );
};

export default BaseRevenue; 