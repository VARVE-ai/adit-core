import {it,expect} from 'vitest';
import {zedFirstFolderPath} from './zed-paths.js';
it.each([[null,''],['  D:\\workersp\\adit  ','D:\\workersp\\adit'],['/one\n/two','/one'],['/one\0/two','/one']])('reads Zed plain folder paths %s',(input,expected)=>{expect(zedFirstFolderPath(input)).toBe(expected);});
