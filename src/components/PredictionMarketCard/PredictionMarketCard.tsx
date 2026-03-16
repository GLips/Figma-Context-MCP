import React, { useEffect, useMemo, useState } from 'react';
import styled, { css } from 'styled-components';
import { ChartBar, Clock, RocketLaunch, Waves } from '@phosphor-icons/react';

type AnimType = 'currency_k' | 'volume' | 'percent' | 'multiplier';
type Flash = 'green' | 'red' | null;

type AnimField = {
  type: AnimType;
  value: number;
  original?: number;
  flash: Flash;
};

type FieldsState = Record<string, AnimField>;

function formatNumber(num: number, type: AnimType) {
  if (type === 'currency_k') return `$${num.toFixed(1)}k`;
  if (type === 'volume') return `$${Math.floor(num).toLocaleString('en-US')}`;
  if (type === 'percent') {
    const arrow = num >= 0 ? '↗' : '↘';
    return `${arrow} ${Math.abs(Math.round(num))}%`;
  }
  if (type === 'multiplier') return `${num.toFixed(2)}x`;
  return String(num);
}

function clampToOriginal(type: AnimType, value: number, original: number) {
  if (value > original * 1.15) return original * 1.1;
  if (value < original * 0.85 && type !== 'percent') return original * 0.9;
  return value;
}

function computeNextValue(type: AnimType, current: number) {
  let deltaPercentage = Math.random() * 0.03 - 0.015;
  if (type === 'percent') deltaPercentage = Math.random() * 0.1 - 0.05;
  if (type === 'multiplier') deltaPercentage = Math.random() * 0.02 - 0.01;
  return current + current * deltaPercentage;
}

const PageCenter = styled.div`
  width: 100%;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
`;

const CardWrap = styled.div`
  width: 100%;
  max-width: 380px;
`;

const Card = styled.div`
  background: #1a1924;
  border: 1px solid #2d2c3a;
  border-radius: 16px;
  padding: 20px;
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.2);
  transition: border-color 300ms ease;

  &:hover {
    border-color: #4b4a5a;
  }
`;

const Header = styled.div`
  display: flex;
  gap: 16px;
  margin-bottom: 20px;
  align-items: flex-start;
`;

const IconTile = styled.div`
  width: 48px;
  height: 48px;
  border-radius: 12px;
  background: rgba(30, 64, 175, 0.4);
  border: 1px solid rgba(30, 64, 175, 0.5);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 300ms ease;

  ${Card}:hover & {
    transform: scale(1.05);
  }
`;

const Title = styled.h3`
  margin: 0;
  font-weight: 600;
  font-size: 16px;
  line-height: 1.35;
  padding-top: 2px;
  color: #ffffff;
`;

const MetaBar = styled.div`
  display: flex;
  align-items: center;
  gap: 16px;
  font-size: 12px;
  font-weight: 500;
  margin-bottom: 20px;
  color: #8b8b9b;
  background: #15141e;
  padding: 10px;
  border-radius: 10px;
  border: 1px solid rgba(45, 44, 58, 0.5);
`;

const MetaGroup = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
`;

const Mono = css`
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
    'Liberation Mono', 'Courier New', monospace;
`;

const AnimVal = styled.span<{ $flash: Flash; $baseColor?: string }>`
  display: inline-block;
  will-change: color, text-shadow;
  transition: color 300ms ease-out, text-shadow 300ms ease-out;
  ${Mono};
  color: ${({ $baseColor }) => $baseColor ?? '#ffffff'};

  ${({ $flash }) =>
    $flash === 'green' &&
    css`
      color: #48bb78 !important;
      text-shadow: 0 0 12px rgba(72, 187, 120, 0.4);
    `}
  ${({ $flash }) =>
    $flash === 'red' &&
    css`
      color: #f56565 !important;
      text-shadow: 0 0 12px rgba(245, 101, 101, 0.4);
    `}
`;

const TimeLeft = styled.div`
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  color: #9f7aea;
  background: rgba(159, 122, 234, 0.1);
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid rgba(159, 122, 234, 0.2);
`;

const Table = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
`;

const Th = styled.th`
  padding-bottom: 8px;
  font-weight: 500;
  color: #8b8b9b;
  text-align: left;
  border-bottom: 1px solid rgba(45, 44, 58, 0.5);

  &:nth-child(2),
  &:nth-child(3),
  &:nth-child(4) {
    text-align: right;
  }
`;

const TBody = styled.tbody`
  tr + tr td {
    border-top: 1px solid rgba(45, 44, 58, 0.3);
  }
`;

const Row = styled.tr`
  cursor: pointer;
  transition: background-color 200ms ease;
  position: relative;

  &:hover {
    background: rgba(26, 25, 36, 0.5);
  }
`;

const Cell = styled.td<{ $tone?: 'primary' | 'secondary' }>`
  padding: 16px 8px;
  color: ${({ $tone }) => ($tone === 'secondary' ? '#8b8b9b' : '#ffffff')};
  font-weight: ${({ $tone }) => ($tone === 'secondary' ? 400 : 500)};
  transition: opacity 200ms ease;

  ${Row}:hover & {
    opacity: 0.3;
  }
`;

const RightMono = styled(Cell)`
  ${Mono};
  text-align: right;
`;

const RightFlex = styled(Cell)<{ $color: 'green' | 'red' }>`
  ${Mono};
  text-align: right;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 4px;
  color: ${({ $color }) => ($color === 'green' ? '#48bb78' : '#f56565')};
`;

const PayoutCell = styled(Cell)`
  ${Mono};
  text-align: right;
  position: relative;
  font-weight: 600;
  color: #48bb78;
`;

const TradeOverlay = styled.div`
  position: absolute;
  inset: 0;
  display: none;
  align-items: center;
  justify-content: flex-end;
  padding: 4px;
  opacity: 1;

  ${Row}:hover & {
    display: flex;
  }
`;

const TradeButton = styled.button`
  height: 28px;
  padding: 0 12px;
  background: #8b5fd4;
  color: #ffffff;
  font-size: 12px;
  font-weight: 600;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  box-shadow: 0 10px 24px rgba(159, 122, 234, 0.4);
  transition: transform 120ms ease;

  &:active {
    transform: scale(0.95);
  }
`;

export function PredictionMarketCardDemo() {
  const initial = useMemo<FieldsState>(
    () => ({
      volume: { type: 'volume', value: 890_100, flash: null },
      totalPool: { type: 'currency_k', value: 210.0, flash: null },
      yesPool: { type: 'currency_k', value: 150.0, flash: null },
      yes24h: { type: 'percent', value: 33, flash: null },
      yesPayout: { type: 'multiplier', value: 1.2, flash: null },
      noPool: { type: 'currency_k', value: 60.0, flash: null },
      no24h: { type: 'percent', value: -15, flash: null },
      noPayout: { type: 'multiplier', value: 4.5, flash: null },
    }),
    [],
  );

  const [fields, setFields] = useState<FieldsState>(() => {
    const next: FieldsState = {};
    for (const [k, v] of Object.entries(initial)) {
      next[k] = { ...v, original: v.value };
    }
    return next;
  });

  useEffect(() => {
    const timer = window.setInterval(() => {
      setFields((prev) => {
        let any = false;
        const next: FieldsState = { ...prev };

        for (const [key, f] of Object.entries(prev)) {
          if (Math.random() > 0.6) continue;
          any = true;

          const original = f.original ?? f.value;
          const candidate = computeNextValue(f.type, f.value);
          const newValue = clampToOriginal(f.type, candidate, original);
          const isPositive = newValue > f.value;

          let flash: Flash = isPositive ? 'green' : 'red';
          if (f.type === 'percent') flash = newValue >= f.value ? 'green' : 'red';

          next[key] = { ...f, value: newValue, original, flash };

          window.setTimeout(() => {
            setFields((curr) => {
              const cur = curr[key];
              if (!cur) return curr;
              if (cur.flash === null) return curr;
              return { ...curr, [key]: { ...cur, flash: null } };
            });
          }, 300);
        }

        return any ? next : prev;
      });
    }, 1800);

    return () => window.clearInterval(timer);
  }, []);

  const yes24h = fields.yes24h.value;
  const no24h = fields.no24h.value;

  return (
    <PageCenter>
      <CardWrap>
        <Card>
          <Header>
            <IconTile>
              <RocketLaunch size={24} weight="fill" color="#60a5fa" />
            </IconTile>
            <Title>SpaceX Starship reaches orbit successfully on flight 4?</Title>
          </Header>

          <MetaBar>
            <MetaGroup title="24H Volume">
              <Waves size={14} color="rgba(255,255,255,0.7)" />
              <AnimVal $flash={fields.volume.flash} $baseColor="#ffffff">
                {formatNumber(fields.volume.value, fields.volume.type)}
              </AnimVal>
            </MetaGroup>

            <MetaGroup title="Total Pool">
              <ChartBar size={14} color="rgba(255,255,255,0.7)" />
              <AnimVal $flash={fields.totalPool.flash} $baseColor="#ffffff">
                {formatNumber(fields.totalPool.value, fields.totalPool.type)}
              </AnimVal>
            </MetaGroup>

            <TimeLeft>
              <Clock size={14} weight="bold" />
              5d left
            </TimeLeft>
          </MetaBar>

          <Table>
            <thead>
              <tr>
                <Th style={{ width: '35%' }}>Outcome</Th>
                <Th>Pool</Th>
                <Th>24H</Th>
                <Th>Payout</Th>
              </tr>
            </thead>
            <TBody>
              <Row>
                <Cell>Yes</Cell>
                <RightMono $tone="secondary">
                  <AnimVal $flash={fields.yesPool.flash} $baseColor="#8b8b9b">
                    {formatNumber(fields.yesPool.value, fields.yesPool.type)}
                  </AnimVal>
                </RightMono>
                <RightFlex $color="green">
                  <AnimVal $flash={fields.yes24h.flash} $baseColor="#48bb78">
                    {formatNumber(yes24h, fields.yes24h.type)}
                  </AnimVal>
                </RightFlex>
                <PayoutCell>
                  <AnimVal $flash={fields.yesPayout.flash} $baseColor="#48bb78">
                    {formatNumber(fields.yesPayout.value, fields.yesPayout.type)}
                  </AnimVal>
                  <TradeOverlay>
                    <TradeButton type="button">Trade</TradeButton>
                  </TradeOverlay>
                </PayoutCell>
              </Row>

              <Row>
                <Cell>No</Cell>
                <RightMono $tone="secondary">
                  <AnimVal $flash={fields.noPool.flash} $baseColor="#8b8b9b">
                    {formatNumber(fields.noPool.value, fields.noPool.type)}
                  </AnimVal>
                </RightMono>
                <RightFlex $color={no24h >= 0 ? 'green' : 'red'}>
                  <AnimVal
                    $flash={fields.no24h.flash}
                    $baseColor={no24h >= 0 ? '#48bb78' : '#f56565'}
                  >
                    {formatNumber(no24h, fields.no24h.type)}
                  </AnimVal>
                </RightFlex>
                <PayoutCell>
                  <AnimVal $flash={fields.noPayout.flash} $baseColor="#48bb78">
                    {formatNumber(fields.noPayout.value, fields.noPayout.type)}
                  </AnimVal>
                  <TradeOverlay>
                    <TradeButton type="button">Trade</TradeButton>
                  </TradeOverlay>
                </PayoutCell>
              </Row>
            </TBody>
          </Table>
        </Card>
      </CardWrap>
    </PageCenter>
  );
}

