#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>

// Windows-subsystem executable: neither this process nor Node allocates a console.
extern "C" void WINAPI Start() {
    int count = 0;
    auto arguments = CommandLineToArgvW(GetCommandLineW(), &count);
    if (!arguments || count != 4) ExitProcess(ERROR_BAD_ARGUMENTS);
    if (!SetEnvironmentVariableW(L"CODEX_ANTIGRAVITY_HOME", arguments[3])) ExitProcess(GetLastError());

    const auto logLength = lstrlenW(arguments[3]) + 40;
    auto logPath = static_cast<wchar_t*>(LocalAlloc(LPTR, logLength * sizeof(wchar_t)));
    if (!logPath) ExitProcess(ERROR_NOT_ENOUGH_MEMORY);
    lstrcpyW(logPath, arguments[3]);
    lstrcatW(logPath, L"\\logs\\supervisor.error.log");
    SECURITY_ATTRIBUTES security = { sizeof(security), nullptr, TRUE };
    auto log = CreateFileW(logPath, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
                          &security, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    auto input = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                            &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (log == INVALID_HANDLE_VALUE || input == INVALID_HANDLE_VALUE) ExitProcess(GetLastError());

    const auto commandLength = lstrlenW(arguments[1]) + lstrlenW(arguments[2]) + 32;
    auto command = static_cast<wchar_t*>(LocalAlloc(LPTR, commandLength * sizeof(wchar_t)));
    if (!command) ExitProcess(ERROR_NOT_ENOUGH_MEMORY);
    lstrcpyW(command, L"\"");
    lstrcatW(command, arguments[1]);
    lstrcatW(command, L"\" --use-system-ca \"");
    lstrcatW(command, arguments[2]);
    lstrcatW(command, L"\"");
    STARTUPINFOW startup = {};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    startup.wShowWindow = SW_HIDE;
    startup.hStdInput = input;
    startup.hStdOutput = log;
    startup.hStdError = log;

    // Stopping the scheduled task closes the job and stops the watchdog and its worker.
    const auto job = CreateJobObjectW(nullptr, nullptr);
    if (!job) ExitProcess(GetLastError());
    auto limits = static_cast<JOBOBJECT_EXTENDED_LIMIT_INFORMATION*>(
        LocalAlloc(LPTR, sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
    if (!limits) ExitProcess(ERROR_NOT_ENOUGH_MEMORY);
    limits->BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, limits, sizeof(*limits))) {
        ExitProcess(GetLastError());
    }
    LocalFree(limits);

    PROCESS_INFORMATION process = {};
    if (!CreateProcessW(arguments[1], command, nullptr, nullptr, TRUE, CREATE_NO_WINDOW | CREATE_SUSPENDED,
                        nullptr, nullptr, &startup, &process)) ExitProcess(GetLastError());
    if (!AssignProcessToJobObject(job, process.hProcess) || ResumeThread(process.hThread) == DWORD(-1)) {
        const auto error = GetLastError();
        TerminateProcess(process.hProcess, error);
        ExitProcess(error);
    }
    CloseHandle(process.hThread);
    WaitForSingleObject(process.hProcess, INFINITE);
    DWORD code = 1;
    GetExitCodeProcess(process.hProcess, &code);
    CloseHandle(process.hProcess);
    CloseHandle(job);
    CloseHandle(input);
    CloseHandle(log);
    LocalFree(command);
    LocalFree(logPath);
    LocalFree(arguments);
    ExitProcess(code);
}
