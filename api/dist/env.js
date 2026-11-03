import { resolve } from 'node:path';
for (const file of [resolve(process.cwd(), '..', '.env'), resolve(process.cwd(), '.env')]) {
    try {
        process.loadEnvFile(file);
    }
    catch {
    }
}
//# sourceMappingURL=env.js.map