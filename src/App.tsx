import { useEffect, useMemo, useState } from 'react';
import { App as AntApp, Badge, Button, Card, Col, Descriptions, Empty, Form, Input, InputNumber, Layout, List, Menu, Row, Select, Space, Statistic, Table, Tag, Timeline, Tooltip, Typography, message } from 'antd';
import { ClockCircleOutlined, FlagOutlined, PlusOutlined, SafetyCertificateOutlined, StopOutlined } from '@ant-design/icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { addProtest, confirmResult, netTimeFor, protestPenaltyFor, recalculateResult, retireEntry, saveResult, setCurrentRole, setRaceStatus, transitionProtest, type AppDispatch, type RootState } from './store';
import { useGetOfficialsQuery } from './api';
import type { Protest, RaceEntry, Role } from './types';

const { Header, Content, Sider } = Layout;

const resultSchema = z.object({
  id: z.string().min(1),
  elapsedSeconds: z.number().positive(),
  penaltySeconds: z.number().min(0),
  note: z.string().max(120)
});
const protestSchema = z.object({
  entryId: z.string().min(1),
  reason: z.string().min(4),
  rule: z.string().min(2)
});

const roleLabels: Record<Role, string> = {
  raceOfficer: '竞赛官',
  arbitrator: '仲裁主席',
  timer: '计时员'
};

function countdown(target: string, now: number) {
  const seconds = Math.max(0, Math.floor((new Date(target).getTime() - now) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function ControlPage() {
  const { t } = useTranslation();
  const dispatch = useDispatch<AppDispatch>();
  const race = useSelector((state: RootState) => state.regatta.races[0]);
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const protests = useSelector((state: RootState) => state.regatta.protests);
  const role = useSelector((state: RootState) => state.regatta.currentRole);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const sorted = useMemo(() => [...entries].sort((a, b) => netTimeFor(a, protests) - netTimeFor(b, protests)), [entries, protests]);

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Row gutter={[18, 18]}>
        <Col xs={24} lg={10}>
          <Card className="hero-card">
            <Badge status={race.status === 'running' ? 'processing' : 'success'} text={`比赛状态：${race.status}`} />
            <Statistic title="距离起航" value={countdown(race.startsAt, now)} prefix={<ClockCircleOutlined />} />
            <Descriptions column={1} style={{ marginTop: 18 }}>
              <Descriptions.Item label="组别">{race.fleet}</Descriptions.Item>
              <Descriptions.Item label="航线">{race.course}</Descriptions.Item>
            </Descriptions>
            <Space wrap>
              <Button type="primary" icon={<FlagOutlined />} onClick={() => dispatch(setRaceStatus({ id: race.id, status: 'running' }))}>开始比赛</Button>
              <Button onClick={() => dispatch(setRaceStatus({ id: race.id, status: 'finished' }))}>结束比赛</Button>
              <Button onClick={() => dispatch(setRaceStatus({ id: race.id, status: 'scheduled' }))}>重置排队</Button>
            </Space>
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card title={t('control')} extra={<Tag color="blue">{sorted.length} 艘参赛船</Tag>}>
            <Table rowKey="id" pagination={false} dataSource={sorted} columns={[
              { title: '排名', render: (_v, _r, index) => index + 1, width: 64 },
              { title: '船名', dataIndex: 'boat' },
              { title: '帆号', dataIndex: 'sailNo' },
              { title: '船长', dataIndex: 'skipper' },
              { title: '当前净用时', render: (_v, r: RaceEntry) => `${netTimeFor(r, protests)}s` },
              { title: '状态', render: (_v, r: RaceEntry) => (
                <Space>
                  {r.retired && <Tag color="red">弃权</Tag>}
                  <Tag color={r.resultStatus === 'official' ? 'green' : r.resultStatus === 'corrected' ? 'orange' : 'default'}>{r.resultStatus}</Tag>
                </Space>
              ) },
              { title: '操作', render: (_v, r: RaceEntry) => (
                r.retired
                  ? <Tag color="red">已弃权</Tag>
                  : <Tooltip title={role === 'timer' ? '计时员无权标记弃权' : '弃权后不再受理该船变更'}><Button size="small" icon={<StopOutlined />} onClick={() => { if (role === 'timer') message.warning('计时员无权标记弃权'); dispatch(retireEntry({ entryId: r.id })); }}>弃权</Button></Tooltip>
              ) }
            ]} />
          </Card>
        </Col>
      </Row>
    </Space>
  );
}

function ResultsPage() {
  const dispatch = useDispatch<AppDispatch>();
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const protests = useSelector((state: RootState) => state.regatta.protests);
  const role = useSelector((state: RootState) => state.regatta.currentRole);
  const [api, contextHolder] = message.useMessage();
  const { register, handleSubmit, reset, formState: { errors } } = useForm<z.infer<typeof resultSchema>>({
    resolver: zodResolver(resultSchema),
    defaultValues: { id: entries[0]?.id, elapsedSeconds: 3200, penaltySeconds: 0, note: '' }
  });
  const submit = (values: z.infer<typeof resultSchema>) => {
    dispatch(saveResult({ ...values, official: false }));
    api.success('成绩已更正并进入待发布状态');
    reset();
  };
  const handlePublish = (entry: RaceEntry) => {
    if (role === 'timer') api.warning('计时员无权发布成绩，已挡回');
    dispatch(saveResult({ id: entry.id, elapsedSeconds: entry.elapsedSeconds, penaltySeconds: entry.penaltySeconds, note: entry.note, official: true }));
  };
  const handleConfirm = (entry: RaceEntry) => {
    if (role === 'timer') api.warning('计时员无权确认成绩，已挡回');
    dispatch(confirmResult({ entryId: entry.id }));
  };
  const handleRecalculate = (entry: RaceEntry) => {
    dispatch(recalculateResult({ entryId: entry.id }));
  };
  return (
    <>
      {contextHolder}
      <Row gutter={[18, 18]}>
        <Col xs={24} lg={10}>
          <Card title="成绩更正">
            <Form layout="vertical" onFinish={handleSubmit(submit)}>
              <Form.Item label="参赛船" validateStatus={errors.id ? 'error' : undefined} help={errors.id?.message}>
                <select {...register('id')} className="native-select">{entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.boat} / {entry.sailNo}</option>)}</select>
              </Form.Item>
              <Form.Item label="航行用时（秒）"><Input type="number" {...register('elapsedSeconds', { valueAsNumber: true })} /></Form.Item>
              <Form.Item label="手动处罚秒数"><Input type="number" {...register('penaltySeconds', { valueAsNumber: true })} /></Form.Item>
              <Form.Item label="更正原因"><Input.TextArea rows={3} {...register('note')} /></Form.Item>
              <Button htmlType="submit" type="primary">保存更正</Button>
            </Form>
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card title="临时与正式成绩">
            <List dataSource={entries} renderItem={(entry) => {
              const protestPenalty = protestPenaltyFor(protests, entry.id);
              const net = netTimeFor(entry, protests);
              const unconfirmed = protests.some((p) => p.entryId === entry.id && p.status === 'resolved' && !p.confirmed);
              return (
                <List.Item actions={[
                  <Tooltip key="recalc" title="按抗议当前有效处罚值重算净用时"><Button size="small" onClick={() => handleRecalculate(entry)}>重算</Button></Tooltip>,
                  <Tooltip key="confirm" title={role === 'timer' ? '计时员无权确认' : '仲裁确认后才能发布'}><Button size="small" onClick={() => handleConfirm(entry)}>确认</Button></Tooltip>,
                  <Tooltip key="publish" title={role === 'timer' ? '计时员无权发布' : unconfirmed ? '存在未确认的抗议处罚' : '发布为正式成绩'}><Button size="small" type="link" onClick={() => handlePublish(entry)}>发布正式</Button></Tooltip>
                ]}>
                  <List.Item.Meta
                    title={`${entry.boat} · 净用时 ${net} 秒`}
                    description={
                      <Space direction="vertical" size={2}>
                        <small>航行 {entry.elapsedSeconds}s + 手动处罚 {entry.penaltySeconds}s + 抗议处罚 {protestPenalty}s</small>
                        <small>{entry.note || '无更正说明'}</small>
                      </Space>
                    }
                  />
                  <Space direction="vertical" align="end">
                    {entry.retired && <Tag color="red">弃权</Tag>}
                    {unconfirmed && <Tag color="orange">待确认</Tag>}
                    <Tag color={entry.resultStatus === 'official' ? 'green' : 'orange'}>{entry.resultStatus}</Tag>
                  </Space>
                </List.Item>
              );
            }} />
          </Card>
        </Col>
      </Row>
    </>
  );
}

function ProtestQueueItem({ item, boat, onAdjudicate, onReject, onConfirm }: {
  item: Protest;
  boat?: string;
  onAdjudicate: (penalty: number) => void;
  onReject: () => void;
  onConfirm: () => void;
}) {
  const [penalty, setPenalty] = useState(30);
  const isResolved = item.status === 'resolved';
  return (
    <List.Item>
      <List.Item.Meta
        title={<Space><Tag color={item.status === 'reviewing' ? 'processing' : item.status === 'resolved' ? 'success' : item.status === 'rejected' ? 'error' : 'default'}>{item.status}</Tag><Tag>{item.rule}</Tag>{isResolved && <Tag color="blue">处罚 {item.penaltySeconds}s</Tag>}{isResolved && (item.confirmed ? <Tag color="green">已确认</Tag> : <Tag color="orange">待确认</Tag>)}</Space>}
        description={<><div>{item.reason}</div><small>{boat}</small>{item.decision && <div><small>裁决：{item.decision}</small></div>}</>}
      />
      <Space direction="vertical">
        <Space>
          <span>处罚</span>
          <InputNumber size="small" min={0} value={penalty} onChange={(v) => setPenalty(v ?? 0)} addonAfter="秒" style={{ width: 110 }} />
        </Space>
        <Space wrap>
          {item.status === 'submitted' && <Button size="small" onClick={() => onAdjudicate(0)}>进入复核</Button>}
          <Tooltip title="按当前有效处罚值裁决，改判仅按差额调整"><Button size="small" type="primary" onClick={() => onAdjudicate(penalty)}>{isResolved ? '改判' : '接受并处罚'}</Button></Tooltip>
          <Button size="small" danger onClick={() => onReject()}>驳回</Button>
          {isResolved && !item.confirmed && <Tooltip title="仲裁重新确认后才能发布成绩"><Button size="small" onClick={() => onConfirm()}>确认</Button></Tooltip>}
        </Space>
      </Space>
    </List.Item>
  );
}

function ProtestsPage() {
  const dispatch = useDispatch<AppDispatch>();
  const protests = useSelector((state: RootState) => state.regatta.protests);
  const timeline = useSelector((state: RootState) => state.regatta.timeline);
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const role = useSelector((state: RootState) => state.regatta.currentRole);
  const [api, contextHolder] = message.useMessage();
  const { register, handleSubmit, reset, formState: { errors } } = useForm<z.infer<typeof protestSchema>>({ resolver: zodResolver(protestSchema), defaultValues: { entryId: entries[0]?.id, reason: '', rule: 'RRS 14' } });
  const submit = (values: z.infer<typeof protestSchema>) => {
    dispatch(addProtest({ raceId: 'race-1', ...values }));
    reset({ entryId: entries[0]?.id, reason: '', rule: 'RRS 14' });
  };
  const warnIfTimer = (): boolean => {
    if (role === 'timer') { api.warning('计时员无权处理抗议，已挡回'); return true; }
    return false;
  };
  return (
    <>
      {contextHolder}
      <Row gutter={[18, 18]}>
        <Col xs={24} lg={9}>
          <Card title="提交抗议">
            <Form layout="vertical" onFinish={handleSubmit(submit)}>
              <Form.Item label="参赛船" validateStatus={errors.entryId ? 'error' : undefined}>
                <select className="native-select" {...register('entryId')}>{entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.boat}</option>)}</select>
              </Form.Item>
              <Form.Item label="适用规则" validateStatus={errors.rule ? 'error' : undefined} help={errors.rule?.message}><Input {...register('rule')} /></Form.Item>
              <Form.Item label="事件描述" validateStatus={errors.reason ? 'error' : undefined} help={errors.reason?.message}><Input.TextArea rows={4} {...register('reason')} /></Form.Item>
              <Button type="primary" htmlType="submit" icon={<PlusOutlined />}>登记抗议</Button>
            </Form>
          </Card>
        </Col>
        <Col xs={24} lg={9}>
          <Card title="冲突复核队列">
            {protests.length === 0 ? <Empty /> : <List dataSource={protests} renderItem={(item) => (
              <ProtestQueueItem
                key={item.id}
                item={item}
                boat={entries.find((entry) => entry.id === item.entryId)?.boat}
                onAdjudicate={(penalty) => { warnIfTimer(); dispatch(transitionProtest({ id: item.id, status: 'resolved', decision: `接受抗议并处以 ${penalty} 秒处罚`, penaltySeconds: penalty })); }}
                onReject={() => { warnIfTimer(); dispatch(transitionProtest({ id: item.id, status: 'rejected', decision: '证据不足，维持原成绩' })); }}
                onConfirm={() => { warnIfTimer(); dispatch(confirmResult({ entryId: item.entryId })); }}
              />
            )} />}
          </Card>
        </Col>
        <Col xs={24} lg={6}>
          <Card title="事件时间线"><Timeline items={timeline.map((event) => ({ color: event.type === 'protest' ? 'orange' : event.type === 'system' ? 'red' : 'blue', children: <><b>{event.type}</b><div>{event.message}</div><small>{new Date(event.time).toLocaleTimeString()}</small></> }))} /></Card>
        </Col>
      </Row>
    </>
  );
}

function Shell() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { data = [] } = useGetOfficialsQuery();
  const role = useSelector((state: RootState) => state.regatta.currentRole);
  const dispatch = useDispatch<AppDispatch>();
  return (
    <AntApp>
      <Layout className="shell">
      <Header className="header">
        <Space><SafetyCertificateOutlined style={{ fontSize: 24 }} /><Typography.Title level={4} style={{ margin: 0, color: 'white' }}>{t('title')}</Typography.Title></Space>
        <Space>
          <Tag>{data.length} 名值班人员</Tag>
          <Select value={role} style={{ width: 140 }} onChange={(value) => dispatch(setCurrentRole(value as Role))} options={(Object.keys(roleLabels) as Role[]).map((r) => ({ value: r, label: roleLabels[r] }))} />
          <Button ghost onClick={() => void i18n.changeLanguage(i18n.language.startsWith('zh') ? 'en' : 'zh')}>{t('language')}</Button>
        </Space>
      </Header>
      <Layout>
        <Sider width={210} breakpoint="lg" collapsedWidth="0" theme="light">
          <Menu mode="inline" selectedKeys={[location.pathname]} onClick={({ key }) => navigate(key)} items={[
            { key: '/', label: t('control'), icon: <FlagOutlined /> },
            { key: '/results', label: t('results'), icon: <ClockCircleOutlined /> },
            { key: '/protests', label: t('protests'), icon: <SafetyCertificateOutlined /> }
          ]} />
        </Sider>
        <Content className="content"><Routes>
          <Route path="/" element={<ControlPage />} />
          <Route path="/results" element={<ResultsPage />} />
          <Route path="/protests" element={<ProtestsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes></Content>
      </Layout>
      </Layout>
    </AntApp>
  );
}

export default function App() { return <BrowserRouter><Shell /></BrowserRouter>; }
