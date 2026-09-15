// Same isolated integration fixture, with its UI-serving lifetime enabled for the matrix runner.
process.argv.push('--serve');
process.env.READDECK_COVER_QA = '1';
require('./readdeck-test');
