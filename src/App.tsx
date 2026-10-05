import { useEffect, useMemo, useState } from 'react';
import { App as AntApp, Alert, Badge, Button, Card, Col, Descriptions, Empty, Form, Input, InputNumber, Layout, List, Menu, Row, Segmented, Space, Statistic, Table, Tag, Timeline, Tooltip, Typography, message } from 'antd';
import { ClockCircleOutlined, FlagOutlined, PlusOutlined, SafetyCertificateOutlined, StopOutlined } from '@ant-design/icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import {
  addProtest, confirmProtestChange, decideProtest, publishResult,
  saveArrival, saveBasePenalty, setRaceStatus, setRole,
  type AppDispatch, type AppThunk, type RootState, type ThunkResult
} from './store';
import { useGetOfficialsQuery } from './api';
import { changeForProtest, isStatusClosed, latestPublication, netSeconds, penaltyBreakdown, ROLE_LABEL } from './domain';
import type { Protest, RaceEntry, Role } from './types';

const { Header, Content, Sider } = Layout;

const arrivalSchema = z.object({
  id: z.string().min(1),
  elapsedSeconds: z.number().positive('到达用时必须大于 0'),
  note: z.string().max(120)
});
const basePenaltySchema = z.object({
  id: z.string().min(1),
  penaltySeconds: z.number().min(0),
  note: z.string().max(120)
});
const protestSchema = z.object({
  entryId: z.string().min(1),
  reason: z.string().min(4),
  rule: z.string().min(2)
});

function countdown(target: string, now: number) {
  const seconds = Math.max(0, Math.floor((new Date(target).getTime() - now) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function useGuarded() {
  const dispatch = useDispatch<AppDispatch>();
  const [api, contextHolder] = message.useMessage();
  const run = (thunk: AppThunk, success?: string) => {
    const result = dispatch(thunk);
    if (!result.ok) api.error(result.reason ?? '操作被拒绝');
    else if (success) api.success(success);
    return result.ok;
  };
  return { run, contextHolder };
}

const STATUS_TEXT: Record<RaceEntry['resultStatus'], string> = { provisional: '临时', corrected: '已更正', official: '正式' };

function ControlPage() {
  const { t } = useTranslation();
  const dispatch = useDispatch<AppDispatch>();
  const race = useSelector((state: RootState) => state.regatta.races[0]);
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const changes = useSelector((state: RootState) => state.regatta.changes);
  const role = useSelector((state: RootState) => state.regatta.role);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const sorted = useMemo(
    () => [...entries].sort((a, b) => netSeconds(changes, a) - netSeconds(changes, b)),
    [entries, changes]
  );

  const changeStatus = (status: typeof race.status) => {
    const result = dispatch(setRaceStatus(status));
    if (!result.ok) message.error(result.reason ?? '操作被拒绝');
  };

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      {role !== 'officer' && <Alert type="warning" showIcon message="当前为只读视角：仅竞赛官可以切换比赛状态（含开始、结束、弃权）" />}
      <Row gutter={[18, 18]}>
        <Col xs={24} lg={10}>
          <Card className="hero-card">
            <Badge status={race.status === 'running' ? 'processing' : race.status === 'abandoned' ? 'error' : 'success'} text={`比赛状态：${race.status}`} />
            <Statistic title="距离起航" value={countdown(race.startsAt, now)} prefix={<ClockCircleOutlined />} />
            <Descriptions column={1} style={{ marginTop: 18 }}>
              <Descriptions.Item label="组别">{race.fleet}</Descriptions.Item>
              <Descriptions.Item label="航线">{race.course}</Descriptions.Item>
            </Descriptions>
            <Space wrap>
              <Tooltip title={role !== 'officer' ? '仅竞赛官可操作' : undefined}>
                <Button type="primary" icon={<FlagOutlined />} disabled={role !== 'officer'} onClick={() => changeStatus('running')}>开始比赛</Button>
              </Tooltip>
              <Tooltip title={role !== 'officer' ? '仅竞赛官可操作' : undefined}>
                <Button disabled={role !== 'officer'} onClick={() => changeStatus('finished')}>结束比赛</Button>
              </Tooltip>
              <Tooltip title={role !== 'officer' ? '仅竞赛官可操作' : undefined}>
                <Button danger icon={<StopOutlined />} disabled={role !== 'officer'} onClick={() => changeStatus('abandoned')}>弃权</Button>
              </Tooltip>
              <Tooltip title={role !== 'officer' ? '仅竞赛官可操作' : undefined}>
                <Button disabled={role !== 'officer'} onClick={() => changeStatus('scheduled')}>重置排队</Button>
              </Tooltip>
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
              { title: '到达用时', dataIndex: 'elapsedSeconds', render: (v: number) => `${v}s` },
              {
                title: '处罚（基础+抗议）',
                render: (_v, r: RaceEntry) => {
                  const breakdown = penaltyBreakdown(changes, r.id);
                  return <span>{breakdown.base}s + {breakdown.protestTotal}s</span>;
                }
              },
              {
                title: '当前净用时',
                render: (_v, r: RaceEntry) => <b>{netSeconds(changes, r)}s</b>
              },
              { title: '状态', render: (_v, r: RaceEntry) => <Tag color={r.resultStatus === 'official' ? 'green' : r.resultStatus === 'corrected' ? 'orange' : 'default'}>{STATUS_TEXT[r.resultStatus]}</Tag> }
            ]} />
          </Card>
        </Col>
      </Row>
    </Space>
  );
}

function ResultsPage() {
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const changes = useSelector((state: RootState) => state.regatta.changes);
  const role = useSelector((state: RootState) => state.regatta.role);
  const raceStatus = useSelector((state: RootState) => state.regatta.races[0].status);
  const { run, contextHolder } = useGuarded();

  const arrivalForm = useForm<z.infer<typeof arrivalSchema>>({
    resolver: zodResolver(arrivalSchema),
    defaultValues: { id: entries[0]?.id, elapsedSeconds: 3200, note: '' }
  });
  const penaltyForm = useForm<z.infer<typeof basePenaltySchema>>({
    resolver: zodResolver(basePenaltySchema),
    defaultValues: { id: entries[0]?.id, penaltySeconds: 0, note: '' }
  });

  const windowClosed = isStatusClosed(raceStatus);

  return (
    <>
      {contextHolder}
      {windowClosed && <Alert style={{ marginBottom: 18 }} type="warning" showIcon message={`比赛已${raceStatus === 'abandoned' ? '弃权' : '结束'}，不再受理成绩与处罚变更` + (raceStatus === 'finished' ? '，但仲裁确认后仍可发布正式成绩' : '')} />}
      <Row gutter={[18, 18]}>
        <Col xs={24} lg={10}>
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Card title="到达数据（计时员）">
              {role !== 'timer' && role !== 'officer'
                ? <Alert type="warning" showIcon message="仅计时员（或竞赛官）可以提交到达数据" />
                : (
                  <Form layout="vertical" onFinish={arrivalForm.handleSubmit((values) => {
                    if (run(saveArrival(values), '到达数据已保存，净用时已按变更记录重算')) arrivalForm.reset({ id: entries[0]?.id, elapsedSeconds: 3200, note: '' });
                  })}>
                    <Form.Item label="参赛船">
                      <select {...arrivalForm.register('id')} className="native-select">{entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.boat} / {entry.sailNo}</option>)}</select>
                    </Form.Item>
                    <Form.Item label="到达用时（秒）" validateStatus={arrivalForm.formState.errors.elapsedSeconds ? 'error' : undefined} help={arrivalForm.formState.errors.elapsedSeconds?.message}>
                      <Input type="number" {...arrivalForm.register('elapsedSeconds', { valueAsNumber: true })} />
                    </Form.Item>
                    <Form.Item label="备注"><Input.TextArea rows={2} {...arrivalForm.register('note')} /></Form.Item>
                    <Tooltip title={windowClosed ? '比赛结束或弃权后不再受理变更' : undefined}>
                      <Button htmlType="submit" type="primary" disabled={windowClosed}>保存到达数据</Button>
                    </Tooltip>
                    <div style={{ marginTop: 8 }}><small>抗议处罚由抗议裁决统一计入，计时员无法在此修改处罚。</small></div>
                  </Form>
                )}
            </Card>
            <Card title="基础处罚（竞赛官）">
              {role !== 'officer'
                ? <Alert type="warning" showIcon message="仅竞赛官可以记录非抗议类基础处罚；处罚变更会立即作废已发布成绩并要求重新发布" />
                : (
                  <Form layout="vertical" onFinish={penaltyForm.handleSubmit((values) => {
                    if (run(saveBasePenalty(values), '基础处罚已记录，相关发布已作废并重算净用时')) penaltyForm.reset({ id: entries[0]?.id, penaltySeconds: 0, note: '' });
                  })}>
                    <Form.Item label="参赛船">
                      <select {...penaltyForm.register('id')} className="native-select">{entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.boat} / {entry.sailNo}</option>)}</select>
                    </Form.Item>
                    <Form.Item label="基础处罚秒数" validateStatus={penaltyForm.formState.errors.penaltySeconds ? 'error' : undefined} help={penaltyForm.formState.errors.penaltySeconds?.message}>
                      <Input type="number" {...penaltyForm.register('penaltySeconds', { valueAsNumber: true })} />
                    </Form.Item>
                    <Form.Item label="处罚原因"><Input.TextArea rows={2} {...penaltyForm.register('note')} /></Form.Item>
                    <Tooltip title={windowClosed ? '比赛结束或弃权后不再受理变更' : undefined}>
                      <Button htmlType="submit" disabled={windowClosed}>记录基础处罚</Button>
                    </Tooltip>
                  </Form>
                )}
            </Card>
          </Space>
        </Col>
        <Col xs={24} lg={14}>
          <Card title="临时与正式成绩（净用时由赛后变更记录统一派生）">
            <List dataSource={entries} renderItem={(entry) => {
              const breakdown = penaltyBreakdown(changes, entry.id);
              const unconfirmed = breakdown.protestChanges.some((change) => !change.confirmed);
              const publication = latestPublication(changes, entry.id);
              const voided = !!publication?.voided;
              const publishBlocked = role !== 'officer' || raceStatus === 'abandoned' || unconfirmed;
              let blockReason: string | undefined;
              if (role !== 'officer') blockReason = '仅竞赛官可以发布正式成绩';
              else if (raceStatus === 'abandoned') blockReason = '比赛已弃权，不能发布成绩';
              else if (unconfirmed) blockReason = '抗议处罚改判后尚未经仲裁重新确认';
              return (
                <List.Item actions={[
                  <Tooltip key="publish" title={blockReason}>
                    <Button size="small" type="link" disabled={publishBlocked} onClick={() => run(publishResult(entry.id), '正式成绩已发布')}>
                      {voided || unconfirmed ? '重新发布正式' : entry.resultStatus === 'official' ? '再次发布' : '发布正式'}
                    </Button>
                  </Tooltip>
                ]}>
                  <List.Item.Meta
                    title={<Space wrap>{entry.boat} · 净用时 <b>{netSeconds(changes, entry)} 秒</b>
                      <Tag color={entry.resultStatus === 'official' ? 'green' : entry.resultStatus === 'corrected' ? 'orange' : 'default'}>{STATUS_TEXT[entry.resultStatus]}</Tag>
                      {unconfirmed && <Tag color="volcano">待仲裁确认</Tag>}
                      {voided && <Tag color="red">发布已作废</Tag>}
                    </Space>}
                    description={<>
                      <div>到达 {entry.elapsedSeconds}s ＋ 基础处罚 {breakdown.base}s ＋ 抗议处罚 {breakdown.protestTotal}s（{breakdown.protestChanges.length} 条有效抗议）</div>
                      <small>{entry.note || '无更正说明'}</small>
                    </>}
                  />
                </List.Item>
              );
            }} />
          </Card>
        </Col>
      </Row>
    </>
  );
}

function ProtestCard({ item }: { item: Protest }) {
  const changes = useSelector((state: RootState) => state.regatta.changes);
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const role = useSelector((state: RootState) => state.regatta.role);
  const raceStatus = useSelector((state: RootState) => state.regatta.races[0].status);
  const change = changeForProtest(changes, item.id);
  const [penalty, setPenalty] = useState<number>(change?.penaltySeconds ?? 30);
  const locked = isStatusClosed(raceStatus);
  const jury = role === 'jury';
  const { run, contextHolder } = useGuarded();

  return (
    <List.Item>
      {contextHolder}
      <List.Item.Meta
        title={<Space wrap>
          <Tag color={item.status === 'reviewing' ? 'processing' : item.status === 'resolved' ? 'success' : item.status === 'rejected' ? 'error' : 'default'}>{item.status}</Tag>
          {item.rule}
          {change && <Tag color={change.confirmed ? 'green' : 'volcano'}>有效处罚 {change.penaltySeconds}s · {change.confirmed ? '已确认' : '待重新确认'}</Tag>}
        </Space>}
        description={<>
          <div>{item.reason}</div>
          <small>{entries.find((entry) => entry.id === item.entryId)?.boat}（{item.decision || '尚未裁决'}）</small>
        </>}
      />
      <Space direction="vertical" align="end">
        {!jury && <Tag color="orange">仅仲裁可裁决</Tag>}
        {locked && <Tag color="red">比赛{raceStatus === 'abandoned' ? '已弃权' : '已结束'}，变更关闭</Tag>}
        <Tooltip title={!jury ? '仅仲裁可操作' : undefined}>
          <Button size="small" disabled={!jury} onClick={() => run(decideProtest({ id: item.id, status: 'reviewing' }), '抗议已进入复核')}>进入复核</Button>
        </Tooltip>
        <Space>
          <InputNumber min={0} step={5} value={penalty} onChange={(value) => setPenalty(value ?? 0)} addonAfter="秒" style={{ width: 110 }} disabled={!jury || locked} />
          <Tooltip title={!jury ? '仅仲裁可操作' : locked ? '比赛结束或弃权后不再受理变更' : undefined}>
            <Button size="small" type="primary" disabled={!jury || locked} onClick={() => run(
              decideProtest({ id: item.id, status: 'resolved', decision: `接受抗议并处以 ${penalty} 秒处罚`, penaltySeconds: penalty }),
              change ? `改判已按差额调整为 ${penalty} 秒，发布作废，待重新确认` : `裁决 ${penalty} 秒，待仲裁确认`
            )}>{change ? '改判处罚' : '接受并处罚'}</Button>
          </Tooltip>
        </Space>
        <Tooltip title={!jury ? '仅仲裁可操作' : locked ? '比赛结束或弃权后不再受理变更' : undefined}>
          <Button size="small" danger disabled={!jury || locked} onClick={() => run(decideProtest({ id: item.id, status: 'rejected', decision: '证据不足，驳回并维持原成绩' }), change ? '抗议驳回，处罚已按差额撤销并重算' : '抗议已驳回')}>驳回</Button>
        </Tooltip>
        {change && !change.confirmed && !locked && (
          <Tooltip title={!jury ? '仅仲裁可确认' : undefined}>
            <Button size="small" type="primary" ghost disabled={!jury} onClick={() => run(confirmProtestChange(item.id), '仲裁已重新确认，竞赛官可以发布正式成绩')}>确认裁决</Button>
          </Tooltip>
        )}
      </Space>
    </List.Item>
  );
}

function ProtestsPage() {
  const protests = useSelector((state: RootState) => state.regatta.protests);
  const timeline = useSelector((state: RootState) => state.regatta.timeline);
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const raceStatus = useSelector((state: RootState) => state.regatta.races[0].status);
  const { run, contextHolder } = useGuarded();
  const { register, handleSubmit, reset, formState: { errors } } = useForm<z.infer<typeof protestSchema>>({ resolver: zodResolver(protestSchema), defaultValues: { entryId: entries[0]?.id, reason: '', rule: 'RRS 14' } });
  const locked = isStatusClosed(raceStatus);

  const submit = (values: z.infer<typeof protestSchema>) => {
    if (run(addProtest(values), '抗议已登记，等待复核')) {
      reset({ entryId: entries[0]?.id, reason: '', rule: 'RRS 14' });
    }
  };

  return (
    <>
      {contextHolder}
      <Row gutter={[18, 18]}>
        <Col xs={24} lg={9}>
          <Card title="提交抗议">
            {locked && <Alert style={{ marginBottom: 12 }} type="error" showIcon message={`比赛已${raceStatus === 'abandoned' ? '弃权' : '结束'}，不再受理新抗议`} />}
            <Form layout="vertical" onFinish={handleSubmit(submit)}>
              <Form.Item label="参赛船" validateStatus={errors.entryId ? 'error' : undefined}>
                <select className="native-select" disabled={locked} {...register('entryId')}>{entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.boat}</option>)}</select>
              </Form.Item>
              <Form.Item label="适用规则" validateStatus={errors.rule ? 'error' : undefined} help={errors.rule?.message}><Input disabled={locked} {...register('rule')} /></Form.Item>
              <Form.Item label="事件描述" validateStatus={errors.reason ? 'error' : undefined} help={errors.reason?.message}><Input.TextArea rows={4} disabled={locked} {...register('reason')} /></Form.Item>
              <Button type="primary" htmlType="submit" icon={<PlusOutlined />} disabled={locked}>登记抗议</Button>
            </Form>
          </Card>
        </Col>
        <Col xs={24} lg={9}>
          <Card title="冲突复核队列（裁决 / 改判 / 确认）">
            {protests.length === 0 ? <Empty /> : <List dataSource={protests} renderItem={(item) => <ProtestCard key={item.id} item={item} />} />}
          </Card>
        </Col>
        <Col xs={24} lg={6}>
          <Card title="事件时间线（改判 / 作废 / 重算留痕）"><Timeline items={timeline.map((event) => ({
            color: event.type === 'protest' ? 'orange' : event.type === 'publish' ? 'green' : event.type === 'system' ? 'red' : 'blue',
            children: <><b>{event.type}</b><div>{event.message}</div><small>{new Date(event.time).toLocaleString()}</small></>
          }))} /></Card>
        </Col>
      </Row>
    </>
  );
}

function Shell() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const dispatch = useDispatch<AppDispatch>();
  const role = useSelector((state: RootState) => state.regatta.role);
  const { data = [] } = useGetOfficialsQuery();
  const roleOptions: { label: string; value: Role }[] = [
    { label: ROLE_LABEL.officer, value: 'officer' },
    { label: ROLE_LABEL.jury, value: 'jury' },
    { label: ROLE_LABEL.timer, value: 'timer' }
  ];
  return (
    <AntApp>
      <Layout className="shell">
      <Header className="header">
        <Space><SafetyCertificateOutlined style={{ fontSize: 24 }} /><Typography.Title level={4} style={{ margin: 0, color: 'white' }}>{t('title')}</Typography.Title></Space>
        <Space>
          <Tag color="gold">当前身份：{ROLE_LABEL[role]}</Tag>
          <Segmented value={role} onChange={(value) => dispatch(setRole(value as Role))} options={roleOptions} />
          <Tag>{data.length} 名值班人员</Tag>
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
