#!/usr/bin/env node
import { run } from '../src/cli.mjs';
try {
  const result = await run(process.argv.slice(2));
  process.stdout.write(typeof result === 'string' ? result + '\n' : JSON.stringify({ok:true,...result}) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ok:false,error:{code:error.code || 'CLI_ERROR',message:error.message,status:error.status,requestId:error.requestId}}) + '\n');
  process.exitCode = 1;
}
