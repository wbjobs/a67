@echo off
chcp 65001 >nul
title Network Flow Analyzer

echo ========================================
echo 网络流量分析器 - Network Flow Analyzer
echo ========================================
echo.

echo [1/3] 检查Python环境...
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未检测到Python，请先安装Python 3.10+
    pause
    exit /b 1
)
echo [OK] Python环境就绪
echo.

echo [2/3] 安装后端依赖...
cd /d "%~dp0backend"
python -m pip install -r requirements.txt -q
if %errorlevel% neq 0 (
    echo [警告] 部分依赖安装失败，尝试继续...
)
echo [OK] 后端依赖安装完成
echo.

echo [3/3] 安装前端依赖...
cd /d "%~dp0frontend"
call npm install --no-audit --no-fund --loglevel=error
if %errorlevel% neq 0 (
    echo [警告] 前端依赖安装失败，请手动运行 npm install
)
echo [OK] 前端依赖安装完成
echo.

echo ========================================
echo 启动服务...
echo ========================================
echo.

echo 正在启动后端服务...
start "Backend Server" cmd /k "cd /d "%~dp0backend" && python main.py"

timeout /t 3 /nobreak >nul

echo 正在启动前端服务...
start "Frontend Server" cmd /k "cd /d "%~dp0frontend" && npm run dev"

echo.
echo ========================================
echo 服务已启动！
echo 后端: ws://localhost:8815
echo 前端: http://localhost:5173
echo ========================================
echo.
echo 请在浏览器中打开: http://localhost:5173
echo 按任意键关闭此窗口（服务将继续运行）...
pause >nul
