// A small stateful stand-in for the AWS APIs K8sConsole uses, for UI tests without an AWS account.
// The AWS SDK honours AWS_ENDPOINT_URL, so the app sends every call here.
//   ECS (JSON 1.1), CloudWatch (JSON 1.0), CloudWatch Logs (JSON 1.1), STS / ELBv2 (query, XML), EC2 (EC2 query, XML)
import { createServer } from 'node:http';

const ACCT = '111122223333';
const REGION = 'eu-west-2';
const CLUSTER = `arn:aws:ecs:${REGION}:${ACCT}:cluster/shop-prod`;
const TG = `arn:aws:elasticloadbalancing:${REGION}:${ACCT}:targetgroup/web-tg/0123456789abcdef`;
const ALB = `arn:aws:elasticloadbalancing:${REGION}:${ACCT}:loadbalancer/app/shop-alb/fedcba9876543210`;
const td = (fam, rev) => `arn:aws:ecs:${REGION}:${ACCT}:task-definition/${fam}:${rev}`;
const now = () => Date.now() / 1000;

export function mockAws() {
  const writes = [];
  const t0 = now();
  const taskDefs = {
    [td('web', 4)]: def('web', 4, 'shop/web:1.4.0'),
    [td('web', 5)]: def('web', 5, 'shop/web:1.5.0'),
    [td('worker', 2)]: def('worker', 2, 'shop/worker:latest', { environment: [{ name: 'DB_PASSWORD', value: 'not-a-real-secret' }] }),
    [td('batch', 1)]: def('batch', 1, 'shop/batch:2.0.0'),
  };
  const services = {
    web: service('web', td('web', 5), 2, 2, { loadBalancers: [{ targetGroupArn: TG, containerName: 'web', containerPort: 8080 }], events: [ev('w1', 120, '(service web) has reached a steady state.')] }),
    worker: service('worker', td('worker', 2), 2, 1, {
      assignPublicIp: 'ENABLED',
      events: [ev('k2', 60, '(service worker) is unable to consistently start tasks successfully.'), ev('k1', 600, '(service worker) has started 1 tasks: (task bbbb).')],
    }),
    batch: service('batch', td('batch', 1), 0, 0),
  };
  const tasks = {
    a1: task('a1'.padEnd(32, 'a'), 'web', td('web', 5), 'RUNNING', '10.0.1.10'),
    a2: task('a2'.padEnd(32, 'a'), 'web', td('web', 5), 'RUNNING', '10.0.2.11'),
    b1: task('b1'.padEnd(32, 'b'), 'worker', td('worker', 2), 'RUNNING', '10.0.1.20'),
    b0: task('b0'.padEnd(32, 'b'), 'worker', td('worker', 2), 'STOPPED', '10.0.1.21', { stopCode: 'EssentialContainerExited', stoppedReason: 'Essential container in task exited', stoppedAt: t0 - 300, containers: [{ name: 'worker', image: 'shop/worker:latest', lastStatus: 'STOPPED', exitCode: 1 }] }),
  };

  function def(family, revision, image, extra = {}) {
    return {
      taskDefinitionArn: td(family, revision),
      family,
      revision,
      status: 'ACTIVE',
      networkMode: 'awsvpc',
      requiresCompatibilities: ['FARGATE'],
      compatibilities: ['EC2', 'FARGATE'],
      cpu: '512',
      memory: '1024',
      registeredAt: t0 - 86400 * revision,
      containerDefinitions: [{ name: family, image, essential: true, portMappings: [{ containerPort: 8080 }], logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-group': `/ecs/${family}`, 'awslogs-region': REGION, 'awslogs-stream-prefix': 'ecs' } }, ...extra }],
    };
  }
  function ev(id, agoSec, message) {
    return { id, createdAt: t0 - agoSec, message };
  }
  function service(name, taskDefinition, desired, running, o = {}) {
    return {
      serviceArn: `arn:aws:ecs:${REGION}:${ACCT}:service/shop-prod/${name}`,
      serviceName: name,
      clusterArn: CLUSTER,
      status: 'ACTIVE',
      desiredCount: desired,
      runningCount: running,
      pendingCount: 0,
      launchType: 'FARGATE',
      platformVersion: 'LATEST',
      taskDefinition,
      deployments: [{ id: `ecs-svc/${name}`, status: 'PRIMARY', rolloutState: 'COMPLETED', taskDefinition, desiredCount: desired, runningCount: running, pendingCount: 0, failedTasks: running < desired ? 3 : 0, createdAt: t0 - 3600, updatedAt: t0 - 60 }],
      loadBalancers: o.loadBalancers ?? [],
      serviceRegistries: [],
      networkConfiguration: { awsvpcConfiguration: { subnets: ['subnet-0aaaaaaaaaaaaaaaa'], securityGroups: ['sg-0bbbbbbbbbbbbbbbb'], assignPublicIp: o.assignPublicIp ?? 'DISABLED' } },
      deploymentConfiguration: { deploymentCircuitBreaker: { enable: true, rollback: true }, minimumHealthyPercent: 100, maximumPercent: 200 },
      deploymentController: { type: 'ECS' },
      schedulingStrategy: 'REPLICA',
      enableExecuteCommand: false,
      createdAt: t0 - 86400 * 30,
      events: o.events ?? [],
      tags: [{ key: 'team', value: 'shop' }],
    };
  }
  function task(id, svc, taskDefinitionArn, lastStatus, ip, o = {}) {
    return {
      taskArn: `arn:aws:ecs:${REGION}:${ACCT}:task/shop-prod/${id}`,
      clusterArn: CLUSTER,
      group: `service:${svc}`,
      taskDefinitionArn,
      lastStatus,
      desiredStatus: lastStatus === 'STOPPED' ? 'STOPPED' : 'RUNNING',
      healthStatus: 'HEALTHY',
      launchType: 'FARGATE',
      cpu: '512',
      memory: '1024',
      availabilityZone: `${REGION}a`,
      attachments: [{ type: 'ElasticNetworkInterface', details: [{ name: 'privateIPv4Address', value: ip }] }],
      enableExecuteCommand: false,
      createdAt: t0 - 1800,
      startedAt: t0 - 1700,
      containers: [{ name: svc, image: `shop/${svc}`, lastStatus, runtimeId: `${id}-1` }],
      ...o,
    };
  }

  const ecs = {
    ListClusters: () => ({ clusterArns: [CLUSTER] }),
    DescribeClusters: () => ({
      clusters: [{ clusterArn: CLUSTER, clusterName: 'shop-prod', status: 'ACTIVE', runningTasksCount: Object.values(tasks).filter((t) => t.lastStatus === 'RUNNING').length, pendingTasksCount: 0, activeServicesCount: Object.values(services).filter((s) => s.status === 'ACTIVE').length, registeredContainerInstancesCount: 0, capacityProviders: ['FARGATE'], settings: [{ name: 'containerInsights', value: 'disabled' }], tags: [] }],
    }),
    ListServices: () => ({ serviceArns: Object.values(services).filter((s) => s.status === 'ACTIVE').map((s) => s.serviceArn) }),
    DescribeServices: (b) => ({ services: b.services.map((x) => services[x.split('/').pop()]).filter(Boolean) }),
    ListTasks: (b) => ({ taskArns: Object.values(tasks).filter((t) => (!b.serviceName || t.group === `service:${b.serviceName}`) && (!b.desiredStatus || t.desiredStatus === b.desiredStatus)).map((t) => t.taskArn) }),
    DescribeTasks: (b) => ({ tasks: b.tasks.map((a) => Object.values(tasks).find((t) => t.taskArn === a || t.taskArn.endsWith(`/${a}`))).filter(Boolean) }),
    ListContainerInstances: () => ({ containerInstanceArns: [] }),
    DescribeTaskDefinition: (b) => {
      const d = taskDefs[b.taskDefinition] ?? Object.values(taskDefs).find((x) => `${x.family}:${x.revision}` === b.taskDefinition);
      if (!d) throw Object.assign(new Error('Unable to describe task definition.'), { code: 'ClientException' });
      return { taskDefinition: d, tags: [] };
    },
    ListTaskDefinitionFamilies: () => ({ families: [...new Set(Object.values(taskDefs).filter((d) => d.status === 'ACTIVE').map((d) => d.family))].sort() }),
    ListTaskDefinitions: (b) => ({ taskDefinitionArns: Object.values(taskDefs).filter((d) => d.status === 'ACTIVE' && d.family === b.familyPrefix).sort((x, y) => y.revision - x.revision).slice(0, b.maxResults ?? 100).map((d) => d.taskDefinitionArn) }),
    UpdateService: (b) => {
      writes.push({ op: 'UpdateService', input: b });
      const s = services[b.service];
      if (b.desiredCount !== undefined) s.desiredCount = b.desiredCount;
      if (b.taskDefinition) s.taskDefinition = taskDefs[b.taskDefinition] ? b.taskDefinition : Object.values(taskDefs).find((d) => `${d.family}:${d.revision}` === b.taskDefinition)?.taskDefinitionArn ?? s.taskDefinition;
      s.events.unshift(ev(`u${writes.length}`, 0, `(service ${s.serviceName}) updated by K8sConsole e2e.`));
      return { service: s };
    },
    StopTask: (b) => {
      writes.push({ op: 'StopTask', input: b });
      const t = Object.values(tasks).find((x) => x.taskArn === b.task);
      t.desiredStatus = 'STOPPED';
      return { task: t };
    },
    RunTask: (b) => {
      writes.push({ op: 'RunTask', input: b });
      const id = `r${writes.length}`.padEnd(32, 'c');
      const fam = (b.taskDefinition.split('/').pop() ?? b.taskDefinition).split(':')[0];
      tasks[id] = task(id, fam, taskDefs[b.taskDefinition] ? b.taskDefinition : td(fam, Number(b.taskDefinition.split(':').pop())), 'PROVISIONING', '10.0.3.30', { group: `family:${fam}`, startedBy: b.startedBy });
      return { tasks: [tasks[id]], failures: [] };
    },
    DeleteService: (b) => {
      writes.push({ op: 'DeleteService', input: b });
      const s = services[b.service];
      s.status = 'DRAINING';
      return { service: s };
    },
    DeregisterTaskDefinition: (b) => {
      writes.push({ op: 'DeregisterTaskDefinition', input: b });
      taskDefs[b.taskDefinition].status = 'INACTIVE';
      return { taskDefinition: taskDefs[b.taskDefinition] };
    },
    RegisterTaskDefinition: (b) => {
      writes.push({ op: 'RegisterTaskDefinition', input: b });
      const rev = Math.max(0, ...Object.values(taskDefs).filter((d) => d.family === b.family).map((d) => d.revision)) + 1;
      const d = { ...b, taskDefinitionArn: td(b.family, rev), revision: rev, status: 'ACTIVE', registeredAt: now() };
      delete d.tags;
      taskDefs[d.taskDefinitionArn] = d;
      return { taskDefinition: d };
    },
  };

  const metric = (base) => {
    const ts = Array.from({ length: 30 }, (_, i) => Math.floor(now() / 60) * 60 - (29 - i) * 60);
    return { Timestamps: ts, Values: ts.map((_, i) => base + 8 * Math.sin(i / 4)) };
  };
  const cloudwatch = {
    GetMetricData: (b) => ({
      MetricDataResults: b.MetricDataQueries.map((q) => {
        const svc = q.MetricStat.Metric.Dimensions.find((d) => d.Name === 'ServiceName')?.Value;
        if (!svc) return { Id: q.Id, Timestamps: [], Values: [], StatusCode: 'Complete' };
        const on = services[svc]?.runningCount > 0;
        return { Id: q.Id, StatusCode: 'Complete', ...(on ? metric(q.MetricStat.Metric.MetricName === 'CPUUtilization' ? (svc === 'web' ? 35 : 70) : 45) : { Timestamps: [], Values: [] }) };
      }),
    }),
  };

  const logLines = (stream) => Array.from({ length: 5 }, (_, i) => ({ timestamp: Date.now() - (5 - i) * 1000, message: `${stream} line ${i + 1}${i === 4 ? ' ERROR upstream timed out' : ''}`, ingestionTime: Date.now(), logStreamName: stream, eventId: `${stream}-${i}` }));
  const logs = {
    GetLogEvents: (b) => ({ events: b.nextToken ? [] : logLines(b.logStreamName), nextForwardToken: 'f/1', nextBackwardToken: 'b/1' }),
    FilterLogEvents: (b) => ({ events: b.nextToken ? [] : [...logLines(`${b.logStreamNamePrefix ?? ''}a1`), ...logLines(`${b.logStreamNamePrefix ?? ''}a2`)].filter((e) => !b.filterPattern || e.message.includes(b.filterPattern)).sort((x, y) => x.timestamp - y.timestamp), searchedLogStreams: [] }),
  };

  const xml = (action, ns, inner) => `<${action}Response xmlns="${ns}"><${action}Result>${inner}</${action}Result><ResponseMetadata><RequestId>e2e</RequestId></ResponseMetadata></${action}Response>`;
  const query = {
    GetCallerIdentity: () => xml('GetCallerIdentity', 'https://sts.amazonaws.com/doc/2011-06-15/', `<Arn>arn:aws:iam::${ACCT}:user/e2e</Arn><UserId>AIDAE2E</UserId><Account>${ACCT}</Account>`),
    DescribeTargetGroups: () =>
      xml('DescribeTargetGroups', 'http://elasticloadbalancing.amazonaws.com/doc/2015-12-01/', `<TargetGroups><member><TargetGroupArn>${TG}</TargetGroupArn><TargetGroupName>web-tg</TargetGroupName><Protocol>HTTP</Protocol><Port>8080</Port><HealthCheckPath>/health</HealthCheckPath><LoadBalancerArns><member>${ALB}</member></LoadBalancerArns></member></TargetGroups>`),
    DescribeTargetHealth: () =>
      xml('DescribeTargetHealth', 'http://elasticloadbalancing.amazonaws.com/doc/2015-12-01/', `<TargetHealthDescriptions>${['10.0.1.10', '10.0.2.11'].map((ip) => `<member><Target><Id>${ip}</Id><Port>8080</Port></Target><TargetHealth><State>healthy</State></TargetHealth></member>`).join('')}</TargetHealthDescriptions>`),
    DescribeSecurityGroups: () =>
      `<DescribeSecurityGroupsResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><requestId>e2e</requestId><securityGroupInfo><item><groupId>sg-0bbbbbbbbbbbbbbbb</groupId><groupName>shop-tasks</groupName><ipPermissions><item><ipProtocol>tcp</ipProtocol><fromPort>22</fromPort><toPort>22</toPort><ipRanges><item><cidrIp>0.0.0.0/0</cidrIp></item></ipRanges></item></ipPermissions></item></securityGroupInfo></DescribeSecurityGroupsResponse>`,
  };

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const target = req.headers['x-amz-target'];
      try {
        if (target) {
          const [svc, op] = String(target).split('.');
          const table = svc.startsWith('AmazonEC2ContainerService') ? ecs : svc.startsWith('GraniteService') ? cloudwatch : svc.startsWith('Logs_') ? logs : null;
          const fn = table?.[op];
          if (!fn) {
            res.writeHead(400, { 'content-type': 'application/x-amz-json-1.1' });
            return res.end(JSON.stringify({ __type: 'UnknownOperationException', message: `mock-aws: ${target}` }));
          }
          const out = fn(body ? JSON.parse(body) : {});
          res.writeHead(200, { 'content-type': svc.startsWith('GraniteService') ? 'application/x-amz-json-1.0' : 'application/x-amz-json-1.1', 'x-amzn-requestid': 'e2e' });
          return res.end(JSON.stringify(out));
        }
        const action = new URLSearchParams(body).get('Action');
        const fn = query[action];
        if (!fn) {
          res.writeHead(400, { 'content-type': 'text/xml' });
          return res.end(`<ErrorResponse><Error><Code>InvalidAction</Code><Message>mock-aws: ${action}</Message></Error></ErrorResponse>`);
        }
        res.writeHead(200, { 'content-type': 'text/xml' });
        res.end(fn());
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/x-amz-json-1.1' });
        res.end(JSON.stringify({ __type: err.code ?? 'ClientException', message: err.message }));
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, writes, services, tasks, close: () => new Promise((r) => server.close(r)), account: ACCT, cluster: CLUSTER });
    }),
  );
}
