import { it, expect, vi, beforeEach, afterEach } from "vitest";
const logout=vi.hoisted(()=>vi.fn());
vi.mock("../local/account.js",()=>({LocalAccount:class{logout=logout;}}));
import { cloudLogoutCommand, cloudResetCredentialsCommand } from "./cloud.js";
beforeEach(()=>{logout.mockReset().mockResolvedValue({connected:false});vi.spyOn(console,"log").mockImplementation(()=>{});process.exitCode=0;});
afterEach(()=>{vi.restoreAllMocks();process.exitCode=0;});
it("uses the same account service for logout and reset without a project dependency",async()=>{
 await cloudLogoutCommand();await cloudResetCredentialsCommand({yes:true});expect(logout).toHaveBeenCalledTimes(2);
});
it("does not reset implicitly",async()=>{await cloudResetCredentialsCommand();expect(logout).not.toHaveBeenCalled();});
