require('../lib/userStore').resetAdministrator().then(() => {
  console.log('管理员已重置为 admin/admin，旧会话已失效。请登录后立即修改密码。');
}).catch(error => { console.error(error.message); process.exitCode = 1; });
