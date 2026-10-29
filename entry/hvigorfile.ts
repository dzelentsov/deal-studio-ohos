import { hapTasks } from '@ohos/hvigor-ohos-plugin';
import { getNode, HvigorNode } from '@ohos/hvigor';
import * as fs from 'fs';
import * as path from 'path';

// 1. Get the current module object
const currentNode: HvigorNode = getNode(__filename);

// 2. Register our renaming task
currentNode.registerTask({
    name: 'createHapTask',
    // Explicitly specify in the build graph that our task
    // MUST run only AFTER the official assembleHap
    dependencies: ['assembleHap'],
    run() {
        const outputDir = path.resolve(__dirname, 'build/default/outputs/default');
        const oldHapPath = path.join(outputDir, 'entry-default-unsigned.hap');
        const newHapPath = path.join(outputDir, 'vera-probe-dyn-unsigned.hap'); // Your file name

        if (fs.existsSync(oldHapPath)) {
            try {
                fs.renameSync(oldHapPath, newHapPath);
                console.log(`> hvigor \x1b[32mFinished :file renamed to "${newHapPath}"...\x1b[0m`);
            } catch (err) {
                console.log(`> hvigor \x1b[1;31mERROR: Ошибка при переименовании: ${err.message}\x1b[0m`);
            }
        } else {
            console.log(`> hvigor \x1b[1;31mERROR: Файл не найден на диске. Путь проверки: ${oldHapPath}\x1b[0m`);
        }
    }
});

export default {
    system: hapTasks,  /* Built-in plugin of Hvigor. It cannot be modified. */
    plugins:[]         /* Custom plugin to extend the functionality of Hvigor. */
}
