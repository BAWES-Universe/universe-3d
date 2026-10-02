import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
export const {chromium}=require('playwright-core');
const executable=require.resolve('@sparticuz/chromium');
export async function launch(){const s=(await import(executable)).default;return chromium.launch({executablePath:await s.executablePath(),headless:true,args:['--no-sandbox','--no-zygote','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--enable-precise-memory-info']});}
